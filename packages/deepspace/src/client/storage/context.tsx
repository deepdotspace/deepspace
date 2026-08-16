/**
 * RecordProvider Context
 *
 * Provides shared authentication state and scope registration for RecordRoom.
 * RecordScope components own individual WebSocket connections.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  type ReactNode,
} from 'react'
import type { CollectionSchema } from '../../shared/types'
import { useAuth, getAuthToken } from '../auth'
import { isLocalDevHost } from '../debug'
import { RecordStore } from './store'
import { ScopeRegistryProvider } from './ScopeRegistry'
import type {
  UserProfile,
  RoomUser,
  RoomConnectionState,
  RecordProviderProps,
  WriteError,
} from './types'

type FetchUserProfile = () => Promise<UserProfile | null>

// ============================================================================
// RecordContext (per-scope connection state)
// ============================================================================

export interface RecordContextValue {
  store: RecordStore
  roomId: string
  /** Collection names registered by this scope's schemas (used for scope resolution priority). */
  registeredCollections?: Set<string>
  userProfile: UserProfile | null
  userProfileLoading: boolean
  refetchUserProfile: () => Promise<void>
  roomRole: string | null
  allUsers: RoomUser[]
  /** True once the first MSG.USER_LIST response has been received. */
  usersLoaded: boolean
  status: RoomConnectionState
  ready: boolean
  /** Schemas discovered via MSG.LIST_SCHEMAS from the server. Available after ready. */
  discoveredSchemas?: CollectionSchema[]
  setUserRole: (userId: string, role: string) => void
  requestUserList: () => void
  registerSubscription: (subscriptionId: string, queryKey: string) => void
  unregisterSubscription: (subscriptionId: string) => void
  sendMessage: (message: { type: string; payload: unknown }) => void
  sendBinary: (data: Uint8Array) => void
  onBinaryMessage: (handler: (data: ArrayBuffer) => void) => () => void
  registerYjsJoinHandler: (docKey: string, handler: (canWrite: boolean) => void) => () => void
  sendConfirmed: (
    message: { type: string; payload: Record<string, unknown> },
    timeoutMs?: number,
  ) => Promise<unknown>
}

export const RecordContext = createContext<RecordContextValue | null>(null)

export function useRecordContext(): RecordContextValue {
  const ctx = useContext(RecordContext)
  if (!ctx) {
    throw new Error('useRecordContext must be used within a RecordScope')
  }
  return ctx
}

// ============================================================================
// RecordAuthContext (shared auth state for RecordScope)
// ============================================================================

export interface RecordAuthContextValue {
  userProfile: UserProfile | null
  userProfileLoading: boolean
  refetchUserProfile: () => Promise<void>
  allowAnonymous: boolean
  /**
   * The one write-failure surface. RecordScope adapts socket rejections onto
   * it (permission/validation) and useMutations dispatches writes it refuses
   * before the room is ready (not_ready), so every rejected write reaches the
   * app's single `onWriteError` prop.
   */
  onWriteError?: (error: WriteError) => void
  /** Get auth token for WebSocket connections. */
  getAuthToken?: () => Promise<string | null>
}

const RecordAuthContext = createContext<RecordAuthContextValue | null>(null)

export function useRecordAuth(): RecordAuthContextValue | null {
  return useContext(RecordAuthContext)
}

// ============================================================================
// Shared provider state
// ============================================================================

interface RecordProviderStateProps {
  children: ReactNode
  fetchUser: FetchUserProfile
  allowAnonymous?: boolean
  getAuthToken?: () => Promise<string | null>
  onWriteError: (error: WriteError) => void
}

function RecordProviderState({
  children,
  fetchUser,
  allowAnonymous = false,
  getAuthToken: getAuthTokenProp,
  onWriteError: onWriteErrorProp,
}: RecordProviderStateProps): React.ReactElement {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [userProfileLoading, setUserProfileLoading] = useState(true)

  // Hold the latest app callback in a ref and expose a stable wrapper, so an
  // inline arrow prop doesn't churn authValue (and every RecordScope under
  // it) on each render.
  const onWriteErrorRef = useRef(onWriteErrorProp)
  onWriteErrorRef.current = onWriteErrorProp

  const onWriteError = useCallback((error: WriteError) => {
    onWriteErrorRef.current(error)
  }, [])

  const refetchUserProfile = useCallback(async () => {
    try {
      const profile = await fetchUser()
      setUserProfile(profile)
    } catch (err) {
      console.error('[RecordProvider] Failed to refetch user profile:', err)
    }
  }, [fetchUser])

  // Fetch user profile on mount and refresh periodically.
  // fetchUser returns null when not signed in — that's fine, no retry needed.
  useEffect(() => {
    let mounted = true
    setUserProfileLoading(true)
    fetchUser()
      .then((profile) => {
        if (mounted) setUserProfile(profile)
      })
      .finally(() => {
        if (mounted) setUserProfileLoading(false)
      })

    const interval = setInterval(() => {
      if (mounted) {
        fetchUser()
          .then((p) => {
            if (mounted) setUserProfile(p)
          })
          .catch(() => {
            /* a transient profile-refresh failure keeps the last profile */
          })
      }
    }, 30000)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [fetchUser])

  const authValue: RecordAuthContextValue = useMemo(
    () => ({
      userProfile,
      userProfileLoading,
      refetchUserProfile,
      allowAnonymous,
      getAuthToken: getAuthTokenProp,
      onWriteError,
    }),
    [
      userProfile,
      userProfileLoading,
      refetchUserProfile,
      allowAnonymous,
      getAuthTokenProp,
      onWriteError,
    ],
  )

  return (
    <RecordAuthContext.Provider value={authValue}>
      <ScopeRegistryProvider>{children}</ScopeRegistryProvider>
    </RecordAuthContext.Provider>
  )
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Default write-error handler. Optimistic mutations (`create`/`put`/`remove`)
 * resolve before the server answers, so a denied or invalid write can only
 * surface through `onWriteError` — if it's unhandled, the app looks like it
 * worked while the server silently rejected. Never let that be fully silent:
 * fall back to a loud console.error that says how to wire real UI.
 *
 * Deduped per unique message: a retry loop hammering the same denied write
 * must not flood the console (or an agent's captured console output) with
 * identical errors — the first occurrence carries all the information.
 */
const seenWriteErrors = new Set<string>()

function defaultOnWriteError(error: WriteError): void {
  // JSON key rather than string concatenation so delimiter characters in a
  // title/detail can't collide two distinct errors into one dedupe entry.
  const key = JSON.stringify([error.kind, error.title, error.detail])
  if (seenWriteErrors.has(key)) return
  // Bound the set so a pathological stream of distinct errors can't grow it
  // forever; clearing just means an occasional repeat log, which is fine.
  if (seenWriteErrors.size >= 100) seenWriteErrors.clear()
  seenWriteErrors.add(key)
  console.error(
    `[deepspace] Write rejected — ${error.title}: ${error.detail}\n` +
      `This error reached no UI. Pass onWriteError to <RecordProvider> (e.g. wire it to a toast) so users see rejected writes. (Further repeats of this error are suppressed.)`,
  )
}

let warnedSignedOutNull = false

/**
 * Test hook: reset the module-level dev-warning latches and the write-error
 * dedupe set, so tests can assert warnings/errors fire from a clean slate.
 * Not part of the public API surface.
 */
export function __resetDevWarningsForTests(): void {
  seenWriteErrors.clear()
  warnedSignedOutNull = false
}

/**
 * Rendered on localhost instead of the silent `null` when the user is signed
 * out and `allowAnonymous` is off — the #1 "my page is blank and nothing says
 * why" trap. Inline styles only: this must not depend on the app's CSS.
 * Production keeps the old behavior (render nothing).
 */
function SignedOutDiagnostic(): React.ReactElement {
  return (
    <div
      role="alert"
      data-deepspace-diagnostic="signed-out"
      style={{
        margin: '24px auto',
        maxWidth: 560,
        padding: '16px 20px',
        border: '1px solid #d97706',
        borderRadius: 8,
        background: '#fffbeb',
        color: '#78350f',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <strong>DeepSpace: nothing rendered because you're signed out.</strong>
      <p style={{ margin: '8px 0 0' }}>
        This page is inside a {'<RecordProvider>'} without <code>allowAnonymous</code>, which
        renders nothing for signed-out visitors. Either add{' '}
        <code>{'<RecordProvider allowAnonymous>'}</code> to show the page publicly, or require
        sign-in before this point (e.g. a protected route / AuthGate).
      </p>
      <p style={{ margin: '8px 0 0', opacity: 0.8 }}>
        This notice only appears on localhost — a deployed app renders nothing here.
      </p>
    </div>
  )
}

/**
 * RecordProvider supplies shared authentication and scope registration.
 * Use `<RecordScope>` for every RecordRoom connection.
 *
 * @example
 * ```tsx
 * <RecordProvider>
 *   <RecordScope roomId="app:slack-clone" schemas={appSchemas}>
 *     <RecordScope roomId={`conv:${channelId}`} schemas={convSchemas}>
 *       <ChannelView />
 *     </RecordScope>
 *   </RecordScope>
 * </RecordProvider>
 * ```
 */
export function RecordProvider({
  children,
  allowAnonymous = false,
  getAuthToken: getAuthTokenProp,
  onWriteError = defaultOnWriteError,
}: RecordProviderProps): React.ReactElement {
  const { isLoaded, isSignedIn } = useAuth()

  // Derive user profile from the JWT — no API call needed.
  // Returns null when not signed in (no error, no console spam).
  const fetchUser = useCallback(async (): Promise<UserProfile | null> => {
    if (!isSignedIn) return null
    const token = await getAuthToken()
    if (!token) return null
    try {
      const parts = token.split('.')
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
      return {
        id: payload.sub,
        name: payload.name ?? '',
        email: payload.email ?? '',
        imageUrl: payload.image ?? undefined,
      }
    } catch {
      return null
    }
  }, [isSignedIn])

  // Build getAuthToken function — use prop override or default to auth module
  const getAuthTokenFn = useCallback(async (): Promise<string | null> => {
    if (getAuthTokenProp) return getAuthTokenProp()
    if (!isSignedIn) return null
    return getAuthToken()
  }, [getAuthTokenProp, isSignedIn])

  // Not loaded yet — render nothing (no loading screens — that's the app's job)
  if (!isLoaded) {
    return <>{null}</>
  }

  // Not signed in and not allowing anonymous — render nothing in production.
  // On localhost this is far more often a missing `allowAnonymous` than a
  // deliberate auth gate, and a bare blank page gives no thread to pull, so
  // dev gets a visible diagnostic instead.
  if (!isSignedIn && !allowAnonymous) {
    if (isLocalDevHost()) {
      if (!warnedSignedOutNull) {
        warnedSignedOutNull = true
        console.warn(
          '[deepspace] RecordProvider rendered nothing: signed out and allowAnonymous is off. ' +
            'Add `allowAnonymous` to show this page to signed-out visitors, or require sign-in before this point.',
        )
      }
      return <SignedOutDiagnostic />
    }
    return <>{null}</>
  }

  // The public callback travels down unchanged; every producer (socket
  // rejections, not-ready mutations) shapes its own WriteError. Passing the
  // raw prop is safe: RecordProviderState holds it in a ref behind a stable
  // wrapper, so its identity never reaches a dependency array.
  return (
    <RecordProviderState
      fetchUser={fetchUser}
      allowAnonymous={allowAnonymous}
      getAuthToken={getAuthTokenFn}
      onWriteError={onWriteError}
    >
      {children}
    </RecordProviderState>
  )
}
