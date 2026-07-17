/**
 * RecordSocket — the ONE WebSocket engine behind both providers
 * (context.tsx's backward-compat RecordProvider and RecordScope).
 *
 * Framework-free: React never appears here. The providers own React state
 * and wire it up via the listener callbacks; everything race-sensitive —
 * the connect-token guard around the async auth-token fetch, reconnect
 * backoff, pending-request settlement, resubscribe-on-open, zombie-reconnect
 * prevention on teardown — lives here, under direct unit test
 * (__tests__/record-socket.test.ts).
 *
 * History: this logic used to exist twice (~250 lines each) and the copies
 * drifted three ways before being unified. Do not fork it again.
 */

import { recordMatchesWhere, reconnectDelayMs } from './record-matching'
import { parseServerError } from './serverErrors'
import type { CollectionSchema } from '../../shared/types'
import type { RoomUser, RoomConnectionState, RecordData } from './types'
import { MSG } from '../../shared/protocol/constants'

// WebSocket readyState per spec — avoids touching the global WebSocket
// object for constants (tests inject WebSocketImpl; node may lack a global).
const WS_CONNECTING = 0
const WS_OPEN = 1

/** The slice of RecordStore the engine writes to (structural, for tests). */
export interface RecordStoreLike {
  setQueryResult(queryKey: string, records: RecordData[]): void
  applyChange(queryKey: string, record: RecordData, changeType: 'create' | 'update' | 'delete'): void
  hasRecord(queryKey: string, recordId: string): boolean
  setError(queryKey: string, error: string): void
  resetToLoading(queryKey: string): void
}

export interface RecordSocketListeners {
  onStatus(status: RoomConnectionState): void
  onReady(ready: boolean): void
  onRole(role: string | null): void
  onUsers(users: RoomUser[]): void
  /** MSG.LIST_SCHEMAS — optional; the compat provider has no schemas surface. */
  onSchemas?(schemas: CollectionSchema[]): void
  onPermissionError?(title: string, detail: string): void
  onValidationError?(title: string, detail: string): void
}

export interface RecordSocketConfig {
  roomId: string
  store: RecordStoreLike
  /** Fetch the auth token for the connection URL. Failures are swallowed —
   *  the socket connects tokenless and the server decides (anonymous rooms
   *  work; authed rooms reject). */
  getToken: () => Promise<string | null>
  listeners: RecordSocketListeners
  /** http(s)/ws(s) base; defaults to window.location. */
  wsUrl?: string
  /** Default '/ws'. */
  wsPathPrefix?: string
  /** Extra query params (e.g. { appId }). The token param is added by connect. */
  extraParams?: Record<string, string>
  /** Diagnostics hook (wsLog/debugLog per provider). */
  log?: (event: string, detail?: unknown) => void
  /** Test injection. Defaults to globalThis.WebSocket. */
  WebSocketImpl?: typeof WebSocket
  /**
   * Persistent registries, owned by the CALLER when the socket can be
   * recreated (auth identity change): hooks register subscriptions/handlers
   * once on mount, so they must survive a socket swap. Default to fresh
   * per-instance containers.
   */
  subscriptions?: Map<string, string>
  binaryHandlers?: Set<(data: ArrayBuffer) => void>
  yjsJoinHandlers?: Map<string, Set<(canWrite: boolean) => void>>
}

interface PendingRequest {
  resolve: (data?: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RecordSocket {
  private ws: WebSocket | null = null
  private readonly subscriptions: Map<string, string> // subscriptionId → queryKey
  private readonly binaryHandlers: Set<(data: ArrayBuffer) => void>
  private readonly yjsJoinHandlers: Map<string, Set<(canWrite: boolean) => void>>
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private reconnectAttempt = 0
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  // Bumped by connect() (on entry) and disconnect()/destroy(). connect()
  // captures it before awaiting the auth token and re-checks after; a
  // mismatch means a teardown (or a newer connect) raced in during the
  // await, so the resolved connect must bail instead of leaking a socket.
  private connectToken = 0
  // Opaque identity the current socket was opened with (e.g. '' for
  // anonymous, the profile id once signed in). A connect() with a DIFFERENT
  // tag while OPEN forces a reconnect so the server sees the new identity.
  private identityTag: string | undefined
  private destroyed = false

  constructor(private readonly config: RecordSocketConfig) {
    this.subscriptions = config.subscriptions ?? new Map()
    this.binaryHandlers = config.binaryHandlers ?? new Set()
    this.yjsJoinHandlers = config.yjsJoinHandlers ?? new Map()
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async connect(identityTag?: string): Promise<void> {
    if (this.destroyed) return
    const { config } = this

    if (this.ws?.readyState === WS_OPEN) {
      if (identityTag !== undefined && identityTag !== this.identityTag) {
        // Identity changed mid-connection (e.g. anonymous → signed-in): the
        // server derives identity from the connection's JWT, so reconnect.
        config.log?.('reconnecting with new identity', config.roomId)
        this.teardownSocket()
      } else {
        return
      }
    }
    if (this.ws?.readyState === WS_CONNECTING) return

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    const myToken = ++this.connectToken

    const params = new URLSearchParams()
    // Identity is derived server-side from the verified JWT — any
    // client-supplied identity params would be stripped at the worker edge,
    // so the token is the only identity we send.
    try {
      const token = await config.getToken()
      if (token) params.set('token', token)
    } catch {
      /* token fetch failed — connect tokenless; the server decides */
    }

    // A teardown or newer connect() raced in while we awaited the token —
    // bail so we don't open (and leak) a socket the caller already tore
    // down, whose onclose would then schedule a zombie reconnect.
    if (this.connectToken !== myToken || this.destroyed) return

    for (const [key, value] of Object.entries(config.extraParams ?? {})) {
      params.set(key, value)
    }

    // Only an explicit tag overwrites the remembered identity — a bare
    // connect() (visibility retry, scheduled reconnect) keeps the last one.
    if (identityTag !== undefined) this.identityTag = identityTag

    const protocol =
      typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const baseUrl =
      config.wsUrl?.replace(/^http/, 'ws') ??
      `${protocol}//${typeof window !== 'undefined' ? window.location.host : ''}`
    const pathPrefix = config.wsPathPrefix ?? '/ws'
    const url = `${baseUrl}${pathPrefix}/${config.roomId}?${params.toString()}`

    config.log?.('connecting', config.roomId)
    const WS = config.WebSocketImpl ?? WebSocket
    const ws = new WS(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      config.log?.('connected', config.roomId)
      config.listeners.onStatus('connected')
      // Re-subscribe every active query. After a plain socket drop the
      // server has no memory of our subscriptions and sends no RESUBSCRIBE
      // (that only fires on membership changes) — without this, a
      // reconnected client silently stops receiving live updates.
      this.resubscribeAll(ws)
    }

    ws.onmessage = (event) => this.handleMessage(event)

    // Code-agnostic on purpose: EVERY close reconnects, including clean/1000
    // and server-initiated 1012 ('state-refresh', sent by
    // BaseRoom.disconnectAllSockets after an out-of-band server-side write).
    // We must NOT special-case "clean" closes as terminal — that would strand
    // a client on stale data after the server kicked it to force a resync.
    // The reconnect's onopen re-subscribes every active query, so fresh
    // QUERY_RESULTs replace the stale store contents (full resync).
    ws.onclose = () => {
      config.log?.('disconnected', config.roomId)
      config.listeners.onStatus('disconnected')
      config.listeners.onReady(false)
      this.ws = null
      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('WebSocket disconnected'))
      }
      this.pendingRequests.clear()
      // Queries show loading (not silently-stale data) until the reconnect
      // resubscribes and fresh results land.
      for (const queryKey of this.subscriptions.values()) {
        config.store.resetToLoading(queryKey)
      }
      const attempt = this.reconnectAttempt
      const delay = reconnectDelayMs(attempt)
      config.log?.('scheduling reconnect', { roomId: config.roomId, attempt, delayMs: delay })
      this.reconnectAttempt = attempt + 1
      this.reconnectTimeout = setTimeout(() => void this.connect(this.identityTag), delay)
    }

    ws.onerror = () => {}
  }

  /**
   * Tear down and reset to a connectable state (auth identity change, scope
   * unmount-and-remount). Emits status 'connecting' so the UI shows progress
   * rather than a dead 'disconnected'.
   */
  disconnect(): void {
    this.connectToken++ // invalidate any in-flight connect() awaiting its token
    this.clearReconnect()
    this.teardownSocket()
    this.config.listeners.onStatus('connecting')
    this.config.listeners.onReady(false)
    this.reconnectAttempt = 0
  }

  /** Final teardown (unmount): no listener calls — the owner is gone. */
  destroy(): void {
    this.destroyed = true
    this.connectToken++
    this.clearReconnect()
    this.teardownSocket()
  }

  /** Zero the backoff (tab became visible, user asked to retry). */
  resetBackoff(): void {
    this.reconnectAttempt = 0
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WS_OPEN
  }

  private clearReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
  }

  /** Close without firing onclose — prevents the zombie-reconnect. */
  private teardownSocket(): void {
    const ws = this.ws
    if (!ws) return
    this.config.log?.('closing', this.config.roomId)
    ws.onclose = null
    ws.onmessage = null
    ws.onerror = null
    ws.onopen = null
    ws.close()
    this.ws = null
  }

  // ── sending ───────────────────────────────────────────────────────────────

  sendMessage(message: { type: string; payload: unknown }): void {
    if (this.ws?.readyState === WS_OPEN) this.ws.send(JSON.stringify(message))
    else this.config.log?.('send dropped (not connected)', message.type)
  }

  sendBinary(data: Uint8Array): void {
    if (this.ws?.readyState === WS_OPEN) this.ws.send(data)
  }

  sendConfirmed(
    message: { type: string; payload: Record<string, unknown> },
    timeoutMs = 10000,
  ): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== WS_OPEN) {
      return Promise.reject(new Error('WebSocket not connected'))
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('Mutation confirmation timed out'))
      }, timeoutMs)
      this.pendingRequests.set(requestId, { resolve, reject, timer })
      ws.send(JSON.stringify({ ...message, payload: { ...message.payload, requestId } }))
    })
  }

  // ── registrations ─────────────────────────────────────────────────────────

  registerSubscription(subscriptionId: string, queryKey: string): void {
    this.subscriptions.set(subscriptionId, queryKey)
  }

  unregisterSubscription(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId)
  }

  onBinaryMessage(handler: (data: ArrayBuffer) => void): () => void {
    this.binaryHandlers.add(handler)
    return () => {
      this.binaryHandlers.delete(handler)
    }
  }

  registerYjsJoinHandler(docKey: string, handler: (canWrite: boolean) => void): () => void {
    if (!this.yjsJoinHandlers.has(docKey)) this.yjsJoinHandlers.set(docKey, new Set())
    this.yjsJoinHandlers.get(docKey)!.add(handler)
    return () => {
      const handlers = this.yjsJoinHandlers.get(docKey)
      if (handlers) {
        handlers.delete(handler)
        if (handlers.size === 0) this.yjsJoinHandlers.delete(docKey)
      }
    }
  }

  // ── message dispatch ──────────────────────────────────────────────────────

  private resubscribeAll(ws: WebSocket): void {
    for (const [subscriptionId, queryKey] of this.subscriptions) {
      try {
        const query = JSON.parse(queryKey)
        ws.send(JSON.stringify({ type: MSG.SUBSCRIBE, payload: { subscriptionId, query } }))
      } catch {
        /* skip invalid query keys */
      }
    }
  }

  private handleMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      this.binaryHandlers.forEach((h) => h(event.data as ArrayBuffer))
      return
    }

    let msg: { type: string; payload: unknown }
    try {
      msg = JSON.parse(event.data as string)
    } catch {
      console.error('[RecordSocket] Failed to parse message')
      return
    }

    const { type, payload } = msg
    const { store, listeners } = this.config

    switch (type) {
      case MSG.USER_INFO: {
        const { role } = payload as { role: string }
        listeners.onRole(role)
        listeners.onReady(true)
        this.reconnectAttempt = 0
        // Auto-request the user list as part of the connection handshake.
        this.sendMessage({ type: MSG.USER_LIST, payload: {} })
        break
      }

      case MSG.USER_LIST:
        listeners.onUsers((payload as { users: RoomUser[] }).users)
        break

      case MSG.QUERY_RESULT: {
        const { subscriptionId, records } = payload as {
          subscriptionId: string
          records: RecordData[]
        }
        const queryKey = this.subscriptions.get(subscriptionId)
        if (queryKey !== undefined) store.setQueryResult(queryKey, records)
        break
      }

      case MSG.RECORD_CHANGE: {
        const { collection, record, changeType } = payload as {
          collection: string
          record: RecordData
          changeType: 'create' | 'update' | 'delete'
        }
        for (const queryKey of this.subscriptions.values()) {
          try {
            const query = JSON.parse(queryKey) as {
              collection: string
              where?: Record<string, unknown>
            }
            if (query.collection !== collection) continue
            const matches = recordMatchesWhere(record, query.where)
            const exists = store.hasRecord(queryKey, record.recordId)
            if (changeType === 'delete') {
              if (exists) store.applyChange(queryKey, record, 'delete')
            } else if (changeType === 'create') {
              if (matches) store.applyChange(queryKey, record, 'create')
            } else {
              if (matches && exists) store.applyChange(queryKey, record, 'update')
              else if (matches && !exists) store.applyChange(queryKey, record, 'create')
              else if (!matches && exists) store.applyChange(queryKey, record, 'delete')
            }
          } catch {
            /* skip invalid query keys */
          }
        }
        break
      }

      case MSG.ERROR: {
        const { subscriptionId, error } = payload as { subscriptionId?: string; error: string }
        if (subscriptionId) {
          const queryKey = this.subscriptions.get(subscriptionId)
          if (queryKey !== undefined) store.setError(queryKey, error)
        } else {
          const parsed = parseServerError(error)
          if (parsed.isPermissionError) listeners.onPermissionError?.(parsed.title, parsed.detail)
          else listeners.onValidationError?.(parsed.title, parsed.detail)
        }
        break
      }

      case MSG.YJS_JOIN: {
        const { collection, recordId, fieldName, canWrite } = payload as {
          collection: string
          recordId: string
          fieldName: string
          canWrite: boolean
        }
        const docKey = `${collection}:${recordId}:${fieldName}`
        this.yjsJoinHandlers.get(docKey)?.forEach((h) => h(canWrite))
        break
      }

      case MSG.ACK: {
        const { requestId, success, error, ...rest } = payload as {
          requestId: string
          success: boolean
          error?: string
          [key: string]: unknown
        }
        const pending = this.pendingRequests.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingRequests.delete(requestId)
          if (success) pending.resolve(rest)
          else pending.reject(new Error(error || 'Mutation rejected'))
        }
        break
      }

      case MSG.LIST_SCHEMAS: {
        const { schemas } = payload as { schemas: CollectionSchema[] }
        listeners.onSchemas?.(schemas ?? [])
        break
      }

      case MSG.RESUBSCRIBE: {
        // Team membership changed — re-subscribe all active queries.
        if (this.ws?.readyState === WS_OPEN) this.resubscribeAll(this.ws)
        break
      }
    }
  }
}
