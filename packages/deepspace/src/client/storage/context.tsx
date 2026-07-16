/**
 * RecordProvider Context
 *
 * Provides WebSocket connection and state management for RecordRoom.
 *
 * Multi-scope mode: RecordProvider can be used without roomId
 * to provide only auth context + ScopeRegistry. RecordScope components
 * handle individual WebSocket connections.
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
import { debugLog, isLocalDevHost } from '../debug'
import { RecordStore } from './store'
import { RecordSocket } from './record-socket'
import { ScopeRegistryProvider } from './ScopeRegistry'
import type {
  UserProfile,
  RoomUser,
  RoomConnectionState,
  FetchUserProfile,
} from './types'
import { MSG } from '@/shared/protocol/constants'

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
    throw new Error('useRecordContext must be used within a RecordProvider')
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
  /** Called by RecordScope when it receives an RBAC permission error */
  onPermissionError?: (title: string, detail: string) => void
  /** Called by RecordScope when it receives a validation/other error */
  onValidationError?: (title: string, detail: string) => void
  /** Get auth token for WebSocket connections. */
  getAuthToken?: () => Promise<string | null>
}

const RecordAuthContext = createContext<RecordAuthContextValue | null>(null)

export function useRecordAuth(): RecordAuthContextValue | null {
  return useContext(RecordAuthContext)
}

// ============================================================================
// Helpers
// ============================================================================


// ============================================================================
// Core Provider (handles WebSocket connection — backward compat mode)
// ============================================================================

interface RecordProviderCoreProps {
  roomId: string
  wsUrl?: string
  children: ReactNode
  fetchUser: FetchUserProfile
  allowAnonymous?: boolean
  getAuthToken?: () => Promise<string | null>
  onPermissionError?: (title: string, detail: string) => void
  onValidationError?: (title: string, detail: string) => void
}

function RecordProviderCore({
  roomId,
  wsUrl,
  children,
  fetchUser,
  allowAnonymous = false,
  getAuthToken: getAuthTokenProp,
  onPermissionError: onPermissionErrorProp,
  onValidationError: onValidationErrorProp,
}: RecordProviderCoreProps): React.ReactElement {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [userProfileLoading, setUserProfileLoading] = useState(true)

  const [roomRole, setRoomRole] = useState<string | null>(null)
  const [allUsers, setAllUsers] = useState<RoomUser[]>([])
  const [usersLoaded, setUsersLoaded] = useState(false)
  const [status, setStatus] = useState<RoomConnectionState>('connecting')
  const [ready, setReady] = useState(false)

  // Callback refs for error handling — the socket's listeners close over
  // these so the latest app callbacks are invoked without socket recreation.
  const onPermissionErrorRef = useRef<((title: string, detail: string) => void) | undefined>(
    undefined,
  )
  const onValidationErrorRef = useRef<((title: string, detail: string) => void) | undefined>(
    undefined,
  )
  onPermissionErrorRef.current = onPermissionErrorProp
  onValidationErrorRef.current = onValidationErrorProp

  const storeRef = useRef<RecordStore>(new RecordStore())
  const socketRef = useRef<RecordSocket | null>(null)
  // Persist across socket recreation (auth change) — hooks register these
  // on mount and never re-register for a socket swap.
  const subscriptionsRef = useRef<Map<string, string>>(new Map())
  const binaryHandlersRef = useRef<Set<(data: ArrayBuffer) => void>>(new Set())
  const yjsJoinHandlersRef = useRef<Map<string, Set<(canWrite: boolean) => void>>>(new Map())
  const userProfileRef = useRef<UserProfile | null>(null)
  userProfileRef.current = userProfile
  const getAuthTokenRef = useRef(getAuthTokenProp)
  getAuthTokenRef.current = getAuthTokenProp

  const refetchUserProfile = useCallback(async () => {
    try {
      const profile = await fetchUser()
      setUserProfile(profile)
    } catch (err) {
      console.error('[RecordProvider] Failed to refetch user profile:', err)
    }
  }, [fetchUser])

  // Fetch user profile on mount and refresh periodically.
  // fetchUser returns null when not signed in — that's fine.
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
      if (mounted)
        fetchUser()
          .then((p) => {
            if (mounted) setUserProfile(p)
          })
          .catch(() => {
            /* a transient profile-refresh failure keeps the last profile */
          })
    }, 30000)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [fetchUser])

  // ── Socket lifecycle ─────────────────────────────────────────────────
  // One shared engine with RecordScope (record-socket.ts) owns everything
  // race-sensitive. The socket is recreated when the connection identity
  // (room, URL, signed-in user) changes; identity changes therefore always
  // reconnect with the current token — including the anonymous → signed-in
  // upgrade the old inline implementation special-cased.

  const userProfileId = userProfile?.id ?? null

  useEffect(() => {
    if (userProfileLoading) return

    const socket = new RecordSocket({
      roomId,
      store: storeRef.current,
      subscriptions: subscriptionsRef.current,
      binaryHandlers: binaryHandlersRef.current,
      yjsJoinHandlers: yjsJoinHandlersRef.current,
      getToken: () => (getAuthTokenRef.current ?? getAuthToken)(),
      wsUrl,
      log: (event, detail) => debugLog(`[WS] ${event}`, detail),
      listeners: {
        onStatus: setStatus,
        onReady: setReady,
        onRole: setRoomRole,
        onUsers: (users) => {
          setAllUsers(users)
          setUsersLoaded(true)
        },
        onPermissionError: (title, detail) => onPermissionErrorRef.current?.(title, detail),
        onValidationError: (title, detail) => onValidationErrorRef.current?.(title, detail),
      },
    })
    socketRef.current = socket

    if (userProfileId || allowAnonymous) {
      void socket.connect(userProfileId ?? '')
    }

    return () => {
      socketRef.current = null
      socket.destroy()
      setStatus('connecting')
      setReady(false)
    }
  }, [roomId, wsUrl, userProfileId, userProfileLoading, allowAnonymous])

  // Reconnect on tab focus
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !socketRef.current?.isOpen) {
        debugLog('[WS] Reconnecting after visibility change')
        socketRef.current?.resetBackoff()
        void socketRef.current?.connect()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const sendMessage = useCallback((message: { type: string; payload: unknown }) => {
    socketRef.current?.sendMessage(message)
  }, [])

  const setUserRole = useCallback(
    (userId: string, role: string) => {
      sendMessage({ type: MSG.SET_ROLE, payload: { userId, role } })
    },
    [sendMessage],
  )

  const requestUserList = useCallback(() => {
    sendMessage({ type: MSG.USER_LIST, payload: {} })
  }, [sendMessage])

  const registerSubscription = useCallback((subscriptionId: string, queryKey: string) => {
    subscriptionsRef.current.set(subscriptionId, queryKey)
  }, [])

  const unregisterSubscription = useCallback((subscriptionId: string) => {
    subscriptionsRef.current.delete(subscriptionId)
  }, [])

  const sendBinary = useCallback((data: Uint8Array) => {
    socketRef.current?.sendBinary(data)
  }, [])

  const onBinaryMessage = useCallback((handler: (data: ArrayBuffer) => void) => {
    binaryHandlersRef.current.add(handler)
    return () => {
      binaryHandlersRef.current.delete(handler)
    }
  }, [])

  const registerYjsJoinHandler = useCallback(
    (docKey: string, handler: (canWrite: boolean) => void) => {
      const handlers = yjsJoinHandlersRef.current
      if (!handlers.has(docKey)) handlers.set(docKey, new Set())
      handlers.get(docKey)!.add(handler)
      return () => {
        const set = handlers.get(docKey)
        if (set) {
          set.delete(handler)
          if (set.size === 0) handlers.delete(docKey)
        }
      }
    },
    [],
  )

  const sendConfirmed = useCallback(
    (
      message: { type: string; payload: Record<string, unknown> },
      timeoutMs = 10000,
    ): Promise<unknown> => {
      const socket = socketRef.current
      if (!socket) return Promise.reject(new Error('WebSocket not connected'))
      return socket.sendConfirmed(message, timeoutMs)
    },
    [],
  )

  const value: RecordContextValue = useMemo(
    () => ({
      store: storeRef.current,
      roomId,
      userProfile,
      userProfileLoading,
      refetchUserProfile,
      roomRole,
      allUsers,
      usersLoaded,
      status,
      ready,
      setUserRole,
      requestUserList,
      registerSubscription,
      unregisterSubscription,
      sendMessage,
      sendBinary,
      onBinaryMessage,
      registerYjsJoinHandler,
      sendConfirmed,
    }),
    [
      roomId,
      userProfile,
      userProfileLoading,
      refetchUserProfile,
      roomRole,
      allUsers,
      usersLoaded,
      status,
      ready,
      setUserRole,
      requestUserList,
      registerSubscription,
      unregisterSubscription,
      sendMessage,
      sendBinary,
      onBinaryMessage,
      registerYjsJoinHandler,
      sendConfirmed,
    ],
  )

  const onPermissionError = useCallback((title: string, detail: string) => {
    onPermissionErrorRef.current?.(title, detail)
  }, [])

  const onValidationError = useCallback((title: string, detail: string) => {
    onValidationErrorRef.current?.(title, detail)
  }, [])

  const authValue: RecordAuthContextValue = useMemo(
    () => ({
      userProfile,
      userProfileLoading,
      refetchUserProfile,
      allowAnonymous,
      getAuthToken: getAuthTokenProp,
      onPermissionError,
      onValidationError,
    }),
    [
      userProfile,
      userProfileLoading,
      refetchUserProfile,
      allowAnonymous,
      getAuthTokenProp,
      onPermissionError,
      onValidationError,
    ],
  )

  return (
    <RecordAuthContext.Provider value={authValue}>
      <ScopeRegistryProvider>
        <RecordContext.Provider value={value}>{children}</RecordContext.Provider>
      </ScopeRegistryProvider>
    </RecordAuthContext.Provider>
  )
}

// ============================================================================
// Auth-Only Provider (multi-scope mode — no roomId, no WS)
// ============================================================================

interface RecordProviderAuthOnlyProps {
  children: ReactNode
  fetchUser: FetchUserProfile
  allowAnonymous?: boolean
  getAuthToken?: () => Promise<string | null>
  onPermissionError?: (title: string, detail: string) => void
  onValidationError?: (title: string, detail: string) => void
}

function RecordProviderAuthOnly({
  children,
  fetchUser,
  allowAnonymous = false,
  getAuthToken: getAuthTokenProp,
  onPermissionError: onPermissionErrorProp,
  onValidationError: onValidationErrorProp,
}: RecordProviderAuthOnlyProps): React.ReactElement {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null)
  const [userProfileLoading, setUserProfileLoading] = useState(true)

  // Hold the latest app callbacks in refs and expose stable wrappers, so an
  // inline arrow prop doesn't churn authValue (and every RecordScope under
  // it) on each render. Mirrors RecordProviderCore.
  const onPermissionErrorRef = useRef(onPermissionErrorProp)
  onPermissionErrorRef.current = onPermissionErrorProp
  const onValidationErrorRef = useRef(onValidationErrorProp)
  onValidationErrorRef.current = onValidationErrorProp

  const onPermissionError = useCallback((title: string, detail: string) => {
    onPermissionErrorRef.current?.(title, detail)
  }, [])

  const onValidationError = useCallback((title: string, detail: string) => {
    onValidationErrorRef.current?.(title, detail)
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
      onPermissionError,
      onValidationError,
    }),
    [
      userProfile,
      userProfileLoading,
      refetchUserProfile,
      allowAnonymous,
      getAuthTokenProp,
      onPermissionError,
      onValidationError,
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
 * A server-rejected write, delivered to `RecordProvider`'s `onWriteError`.
 * One structured object rather than positional strings so future rejection
 * kinds (rate-limit, quota, dropped-while-offline) and correlation fields
 * (collection, recordId, the raw server string) can be added without
 * breaking the callback signature.
 */
export interface WriteError {
  /** 'permission' — an RBAC denial; 'validation' — missing/immutable/invalid field or any other rejection. */
  kind: 'permission' | 'validation'
  /** Short human-readable summary, safe to show end users. */
  title: string
  /** Longer human-readable explanation; may be empty. */
  detail: string
}

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

let warnedIgnoredSchemas = false
let warnedSignedOutNull = false

/**
 * Test hook: reset the module-level dev-warning latches and the write-error
 * dedupe set, so tests can assert warnings/errors fire from a clean slate.
 * Not part of the public API surface.
 */
export function __resetDevWarningsForTests(): void {
  seenWriteErrors.clear()
  warnedIgnoredSchemas = false
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
 * RecordProvider - Main entry point for storage.
 *
 * Two modes:
 * 1. **Single-scope (backward compat):** Pass `roomId` + `schemas`. Opens one WS connection.
 * 2. **Multi-scope:** Omit `roomId`. Only provides auth + ScopeRegistry.
 *    Use `<RecordScope>` components for individual WS connections.
 *
 * @example
 * ```tsx
 * // Single-scope (backward compat)
 * <RecordProvider roomId="my-app" schemas={schemas}>
 *   <App />
 * </RecordProvider>
 *
 * // Multi-scope
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
  roomId,
  schemas,
  wsUrl,
  children,
  allowAnonymous = false,
  getAuthToken: getAuthTokenProp,
  onWriteError = defaultOnWriteError,
}: {
  roomId?: string
  /**
   * Accepted for API compatibility with `RecordScope` and documented usage,
   * but the single-scope backward-compat provider does no local-first
   * registration, so it's ignored. Pass schemas to `RecordScope` instead.
   */
  schemas?: CollectionSchema[]
  wsUrl?: string
  children: ReactNode
  allowAnonymous?: boolean
  getAuthToken?: () => Promise<string | null>
  /**
   * Called when the server rejects a write. Optimistic mutations
   * (`create`/`put`/`remove`) resolve before the server answers, so this
   * callback is the only place a denied or invalid write surfaces — wire it
   * to your toast/alert system and branch on `error.kind`. Defaults to a
   * deduped console.error so rejections are never fully silent.
   */
  onWriteError?: (error: WriteError) => void
}): React.ReactElement {
  const { isLoaded, isSignedIn } = useAuth()

  if (schemas && roomId && isLocalDevHost() && !warnedIgnoredSchemas) {
    warnedIgnoredSchemas = true
    console.warn(
      '[deepspace] RecordProvider received a `schemas` prop alongside `roomId`, but the single-scope provider ignores it — ' +
        'schemas are resolved server-side in this mode. Remove the `schemas` prop, or adopt the multi-scope shape and pass schemas to <RecordScope>.',
    )
  }

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

  // Adapt the public structured callback onto the two internal channels the
  // socket layer dispatches (permission vs validation). Inline arrows are
  // fine here: Core/AuthOnly hold them in refs behind stable wrappers, so
  // their identity never reaches a dependency array.
  const onPermissionError = (title: string, detail: string) =>
    onWriteError({ kind: 'permission', title, detail })
  const onValidationError = (title: string, detail: string) =>
    onWriteError({ kind: 'validation', title, detail })

  if (roomId) {
    return (
      <RecordProviderCore
        roomId={roomId}
        wsUrl={wsUrl}
        fetchUser={fetchUser}
        allowAnonymous={allowAnonymous}
        getAuthToken={getAuthTokenFn}
        onPermissionError={onPermissionError}
        onValidationError={onValidationError}
      >
        {children}
      </RecordProviderCore>
    )
  }

  return (
    <RecordProviderAuthOnly
      fetchUser={fetchUser}
      allowAnonymous={allowAnonymous}
      getAuthToken={getAuthTokenFn}
      onPermissionError={onPermissionError}
      onValidationError={onValidationError}
    >
      {children}
    </RecordProviderAuthOnly>
  )
}
