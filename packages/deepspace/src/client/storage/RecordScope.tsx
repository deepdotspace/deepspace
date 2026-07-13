/**
 * RecordScope
 *
 * Opens a direct WebSocket connection to a RecordRoom DO.
 * Manages subscriptions, reconnection, and state via RecordStore.
 * Registers collections in ScopeRegistry so hooks resolve to the right scope.
 *
 * @example
 * ```tsx
 * <RecordProvider>
 *   <RecordScope
 *     roomId="app:my-app"
 *     schemas={appSchemas}
 *     appId="my-app"
 *     sharedScopes={[
 *       { roomId: 'workspace:default', schemas: workspaceSchemas },
 *     ]}
 *   >
 *     <App />
 *   </RecordScope>
 * </RecordProvider>
 * ```
 */

import React, { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react'
import type { CollectionSchema } from '../../shared/types'
import { RecordContext, type RecordContextValue } from './context'
import { useRecordAuth } from './context'
import { RecordStore } from './store'
import { RecordSocket } from './record-socket'
import { useScopeRegistry, type ScopeEntry } from './ScopeRegistry'
import { getAuthToken } from '../auth'
import { wsLog } from './ws-log'
import type { RoomConnectionState, RoomUser } from './types'
import { MSG } from '@/shared/protocol/constants'

// ============================================================================
// Helpers
// ============================================================================


// ============================================================================
// Types
// ============================================================================

interface SharedScopeConfig {
  roomId: string
  schemas: CollectionSchema[]
}

interface RecordScopeProps {
  roomId: string
  schemas: CollectionSchema[]
  children?: ReactNode
  /** App ID passed to the server for schema resolution. */
  appId: string
  /** Additional scopes to connect (headless — no children, just register collections). */
  sharedScopes?: SharedScopeConfig[]
  /** WebSocket base URL override. Derived from window.location if omitted. */
  wsUrl?: string
  /** Path prefix for WebSocket route. Default: '/ws'. */
  wsPathPrefix?: string
  /** Don't register collections in ScopeRegistry (prevents name collisions). */
  isolated?: boolean
}

// ============================================================================
// Headless scope — opens a WS connection and registers collections only
// ============================================================================

function HeadlessScope({
  roomId,
  schemas,
  appId,
  wsUrl,
  wsPathPrefix,
}: {
  roomId: string
  schemas: CollectionSchema[]
  appId: string
  wsUrl?: string
  wsPathPrefix?: string
}) {
  return (
    <ScopeConnection
      roomId={roomId}
      schemas={schemas}
      appId={appId}
      wsUrl={wsUrl}
      wsPathPrefix={wsPathPrefix}
    />
  )
}

// ============================================================================
// Core WebSocket connection logic (shared by primary + headless scopes)
// ============================================================================

function ScopeConnection({
  roomId,
  schemas,
  appId,
  children,
  wsUrl,
  wsPathPrefix = '/ws',
  isolated = false,
}: {
  roomId: string
  schemas: CollectionSchema[]
  appId: string
  children?: ReactNode
  wsUrl?: string
  wsPathPrefix?: string
  isolated?: boolean
}) {
  const auth = useRecordAuth()
  const registry = useScopeRegistry()

  const scopeIdRef = useRef(`scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

  // Room state
  const [roomRole, setRoomRole] = useState<string | null>(null)
  const [allUsers, setAllUsers] = useState<RoomUser[]>([])
  const [usersLoaded, setUsersLoaded] = useState(false)
  const [status, setStatus] = useState<RoomConnectionState>('connecting')
  const [ready, setReady] = useState(false)
  const [discoveredSchemas, setDiscoveredSchemas] = useState<CollectionSchema[]>([])

  // Refs
  const storeRef = useRef<RecordStore>(new RecordStore())
  const socketRef = useRef<RecordSocket | null>(null)
  // Persist across socket recreation (auth change) — hooks register these
  // on mount and never re-register for a socket swap.
  const subscriptionsRef = useRef<Map<string, string>>(new Map())
  const binaryHandlersRef = useRef<Set<(data: ArrayBuffer) => void>>(new Set())
  const yjsJoinHandlersRef = useRef<Map<string, Set<(canWrite: boolean) => void>>>(new Map())

  // Auth refs (stable across renders)
  const userProfileRef = useRef(auth?.userProfile ?? null)
  userProfileRef.current = auth?.userProfile ?? null
  const getAuthTokenRef = useRef(auth?.getAuthToken ?? null)
  getAuthTokenRef.current = auth?.getAuthToken ?? null
  const authCallbacksRef = useRef({
    onPermissionError: auth?.onPermissionError,
    onValidationError: auth?.onValidationError,
  })
  authCallbacksRef.current.onPermissionError = auth?.onPermissionError
  authCallbacksRef.current.onValidationError = auth?.onValidationError
  const allowAnonymous = auth?.allowAnonymous ?? false

  // ── Socket lifecycle ─────────────────────────────────────────────────
  // The engine (RecordSocket) owns everything race-sensitive: connect-token
  // guard, backoff, resubscribe-on-open, pending-request settlement. This
  // component owns React state and recreates the socket when the connection
  // identity (room, URL, app, or signed-in user) changes.

  const userProfileId = auth?.userProfile?.id ?? null
  const userProfileLoading = auth?.userProfileLoading ?? false

  useEffect(() => {
    // Still loading auth — wait (avoids an anonymous connect that is
    // immediately torn down when the profile lands).
    if (userProfileLoading) return

    const socket = new RecordSocket({
      roomId,
      store: storeRef.current,
      subscriptions: subscriptionsRef.current,
      binaryHandlers: binaryHandlersRef.current,
      yjsJoinHandlers: yjsJoinHandlersRef.current,
      getToken: () => (getAuthTokenRef.current ?? getAuthToken)(),
      wsUrl,
      wsPathPrefix,
      extraParams: { appId },
      log: (event) => wsLog(event as Parameters<typeof wsLog>[0], roomId),
      listeners: {
        onStatus: setStatus,
        onReady: setReady,
        onRole: setRoomRole,
        onUsers: (users) => {
          setAllUsers(users)
          setUsersLoaded(true)
        },
        onSchemas: setDiscoveredSchemas,
        onPermissionError: (title, detail) =>
          authCallbacksRef.current.onPermissionError?.(title, detail),
        onValidationError: (title, detail) =>
          authCallbacksRef.current.onValidationError?.(title, detail),
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
  }, [roomId, wsUrl, wsPathPrefix, appId, userProfileId, userProfileLoading, allowAnonymous])

  // Reconnect on tab focus
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !socketRef.current?.isOpen) {
        socketRef.current?.resetBackoff()
        void socketRef.current?.connect()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // ── Send helpers (stable delegates to the engine) ────────────────────

  const sendMessage = useCallback((message: { type: string; payload: unknown }) => {
    socketRef.current?.sendMessage(message)
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

  // Auto-discover schemas
  useEffect(() => {
    if (ready) sendMessage({ type: MSG.LIST_SCHEMAS, payload: {} })
  }, [ready, sendMessage])

  // ── ScopeRegistry ────────────────────────────────────────────────────

  const scopeEntryRef = useRef<ScopeEntry | null>(null)
  if (!scopeEntryRef.current) {
    scopeEntryRef.current = {
      store: storeRef.current,
      sendMessage,
      sendConfirmed,
      registerSubscription,
      unregisterSubscription,
      sendBinary,
      onBinaryMessage,
      registerYjsJoinHandler,
      ready,
      status,
    }
  }
  scopeEntryRef.current.ready = ready
  scopeEntryRef.current.status = status

  const registeredSchemasRef = useRef<CollectionSchema[] | null>(null)
  if (!isolated && registry && schemas !== registeredSchemasRef.current) {
    if (registeredSchemasRef.current) {
      registry.unregister(
        scopeIdRef.current,
        registeredSchemasRef.current.map((s) => s.name),
      )
    }
    const names = schemas.map((s) => s.name)
    if (names.length > 0) registry.register(scopeIdRef.current, names, scopeEntryRef.current!)
    registeredSchemasRef.current = schemas
  }

  useEffect(() => {
    if (isolated || !registry) return
    // scopeId is assigned once at init and never reassigned; capture it so the
    // cleanup doesn't read a possibly-changed ref (it can't here, but the rule
    // can't prove that).
    const scopeId = scopeIdRef.current
    return () => {
      const names = (registeredSchemasRef.current ?? []).map((s) => s.name)
      if (names.length > 0) registry.unregister(scopeId, names)
    }
  }, [isolated, registry, roomId])

  // ── Context ──────────────────────────────────────────────────────────

  const registeredCollections = useMemo(() => new Set(schemas.map((s) => s.name)), [schemas])

  const value: RecordContextValue = useMemo(
    () => ({
      store: storeRef.current,
      roomId,
      registeredCollections,
      userProfile: auth?.userProfile ?? null,
      userProfileLoading: auth?.userProfileLoading ?? false,
      refetchUserProfile: auth?.refetchUserProfile ?? (async () => {}),
      roomRole,
      allUsers,
      usersLoaded,
      status,
      ready,
      discoveredSchemas,
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
      registeredCollections,
      auth?.userProfile,
      auth?.userProfileLoading,
      auth?.refetchUserProfile,
      roomRole,
      allUsers,
      usersLoaded,
      status,
      ready,
      discoveredSchemas,
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

  if (!children) return null
  return <RecordContext.Provider value={value}>{children}</RecordContext.Provider>
}

// ============================================================================
// RecordScope (public API)
// ============================================================================

export function RecordScope({
  roomId,
  schemas,
  children,
  appId,
  sharedScopes,
  wsUrl,
  wsPathPrefix = '/ws',
  isolated = false,
}: RecordScopeProps) {
  return (
    <>
      {sharedScopes?.map((shared) => (
        <HeadlessScope
          key={shared.roomId}
          roomId={shared.roomId}
          schemas={shared.schemas}
          appId={appId}
          wsUrl={wsUrl}
          wsPathPrefix={wsPathPrefix}
        />
      ))}
      <ScopeConnection
        roomId={roomId}
        schemas={schemas}
        appId={appId}
        wsUrl={wsUrl}
        wsPathPrefix={wsPathPrefix}
        isolated={isolated}
      >
        {children}
      </ScopeConnection>
    </>
  )
}
