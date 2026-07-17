/**
 * BaseRoom — Abstract base class for all DeepSpace Durable Objects.
 *
 * Provides:
 * - WebSocket upgrade with Cloudflare hibernation API
 * - Connection tracking (WebSocket -> UserAttachment)
 * - Auth: parse JWT-verified user info from URL search params
 * - Presence: connected users list, awareness on connect/disconnect
 * - Message routing: JSON parse -> dispatch by `type` field, binary hook
 * - Raw SQLite access via this.sql
 * - Broadcast helpers: broadcast(), sendTo()
 * - HTTP fetch handler with WebSocket upgrade detection
 * - Internal control-plane endpoint: POST /internal/disconnect-sockets
 *   (force every client to reconnect and resync after out-of-band writes)
 *
 * Subclasses implement lifecycle hooks:
 *   onConnect, onMessage, onBinaryMessage, onDisconnect, onRequest, onAlarm
 */

/// <reference types="@cloudflare/workers-types" />

import type { ServerMessage } from '../../shared/protocol/messages'

// ============================================================================
// User Attachment (survives DO hibernation via WebSocket serialization)
// ============================================================================

export interface UserAttachment {
  userId: string
  userName: string
  userEmail: string
  userImageUrl?: string
  /** Subclass-specific data serialized alongside user info */
  [key: string]: unknown
}

// ============================================================================
// BaseRoom
// ============================================================================

export abstract class BaseRoom<E = Record<string, unknown>> {
  protected state: DurableObjectState
  protected env: E
  protected sql: SqlStorage

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state
    this.env = (env ?? {}) as E
    this.sql = state.storage.sql

    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    )
  }

  // ==========================================================================
  // HTTP Entry Point
  // ==========================================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Internal control-plane endpoints. These are reachable ONLY via a DO stub
    // fetch from the app worker's own server-side code (same trust model as the
    // `/api/tools/execute` surface) — the app worker's public `/ws/:roomId`
    // proxy forwards only `/ws/*` paths, so a browser can never reach
    // `/internal/*` through it. Do NOT add a public app-worker route that
    // forwards arbitrary paths to a room DO.
    const internal = await this.handleInternalRequest(request, url)
    if (internal) return internal

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request, url)
    }

    // Delegate non-WS requests to subclass
    if (this.onRequest) {
      return this.onRequest(request)
    }

    return new Response('Not Found', { status: 404 })
  }

  // ==========================================================================
  // Internal Control-Plane Endpoints
  // ==========================================================================

  /**
   * Handle built-in `/internal/*` control-plane routes shared by every room
   * type. Returns a `Response` if the request was an internal route, or `null`
   * to let the caller continue normal dispatch.
   *
   * Currently:
   * - `POST /internal/disconnect-sockets` — close every live WebSocket so
   *   clients reconnect and resync. Optional JSON body `{ code?, reason? }`
   *   overrides the defaults (1012 / 'state-refresh'). Responds with
   *   `{ success: true, closed: <n> }`.
   *
   * See the security note on `fetch()`: this path is only reachable via DO
   * stub fetch from the app worker, never from the public internet.
   */
  protected async handleInternalRequest(
    request: Request,
    url: URL
  ): Promise<Response | null> {
    if (
      request.method === 'POST' &&
      url.pathname === '/internal/disconnect-sockets'
    ) {
      let options: { code?: number; reason?: string } | undefined
      try {
        const text = await request.text()
        if (text) options = JSON.parse(text) as { code?: number; reason?: string }
      } catch {
        // Malformed/empty body → fall back to defaults.
      }
      const closed = this.disconnectAllSockets(options)
      return Response.json({ success: true, closed })
    }

    return null
  }

  // ==========================================================================
  // WebSocket Connection
  // ==========================================================================

  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    const userId = url.searchParams.get('userId') || undefined
    const userName = url.searchParams.get('userName') || 'Anonymous'
    const userEmail = url.searchParams.get('userEmail') || ''
    const userImageUrl = url.searchParams.get('userImageUrl') || undefined

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.state.acceptWebSocket(server)

    const role = url.searchParams.get('role') || undefined

    const attachment: UserAttachment = {
      userId: userId ?? `anon-${crypto.randomUUID()}`,
      userName,
      userEmail,
      userImageUrl,
      role,
    }

    // Let subclass augment the attachment and perform setup
    const augmented = await this.onConnect(server, attachment) ?? attachment
    server.serializeAttachment(augmented)

    return new Response(null, { status: 101, webSocket: client })
  }

  // ==========================================================================
  // Hibernation API Handlers
  // ==========================================================================

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = ws.deserializeAttachment() as UserAttachment | null
    if (!attachment) return

    // Binary messages
    if (message instanceof ArrayBuffer) {
      if (this.onBinaryMessage) {
        try {
          await this.onBinaryMessage(ws, attachment, message)
        } catch (e) {
          console.error(`[${this.constructor.name}] Binary message error:`, e)
        }
      }
      return
    }

    // JSON messages
    try {
      const msg = JSON.parse(message)
      await this.onMessage(ws, attachment, msg)
    } catch (e) {
      console.error(`[${this.constructor.name}] Message error:`, e)
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as UserAttachment | null
    if (attachment) {
      try {
        await this.onDisconnect(ws, attachment)
      } catch { /* best-effort */ }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error(`[${this.constructor.name}] webSocketError:`, error)
  }

  async alarm(): Promise<void> {
    if (this.onAlarm) {
      await this.onAlarm()
    }
  }

  // ==========================================================================
  // Lifecycle Hooks (subclasses override)
  // ==========================================================================

  /**
   * Called when a new WebSocket connects (after auth parsing).
   * Return an augmented attachment to serialize on the WebSocket,
   * or void to use the default attachment.
   */
  protected onConnect(
    _ws: WebSocket,
    _user: UserAttachment
  ): UserAttachment | void | Promise<UserAttachment | void> {
    // Default: no-op
  }

  /**
   * Called for each parsed JSON message.
   */
  protected abstract onMessage(
    ws: WebSocket,
    user: UserAttachment,
    message: { type: string; [key: string]: unknown }
  ): void | Promise<void>

  /**
   * Called for binary messages (Yjs, custom protocols).
   */
  protected onBinaryMessage?(
    ws: WebSocket,
    user: UserAttachment,
    data: ArrayBuffer
  ): void | Promise<void>

  /**
   * Called when a WebSocket disconnects.
   */
  protected onDisconnect(
    _ws: WebSocket,
    _user: UserAttachment
  ): void | Promise<void> {
    // Default: no-op
  }

  /**
   * Called for HTTP requests that are NOT WebSocket upgrades.
   */
  protected onRequest?(request: Request): Response | Promise<Response>

  /**
   * Called on DO alarm.
   */
  protected onAlarm?(): void | Promise<void>

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Get all connected WebSockets.
   */
  protected getWebSockets(): WebSocket[] {
    return this.state.getWebSockets()
  }

  /**
   * Force every connected client to reconnect and resync by closing all live
   * WebSockets. Returns the number of sockets closed.
   *
   * Use this after an **out-of-band, server-side write** to the room's records
   * — an admin import route, a migration script, a cron job, or a server
   * action — that connected clients have no way to learn about. Without it, a
   * browser tab holding stale in-memory state keeps operating on (and may
   * autosave over) data that changed underneath it. Closing the socket makes
   * the client SDK reconnect and pull fresh query results.
   *
   * The default close code is 1012 ("service restart") with reason
   * 'state-refresh'. The DeepSpace client treats *any* close as a reconnect
   * trigger (it does not special-case clean/1000 closes), so on reconnect it
   * re-subscribes every active query and receives fresh `QUERY_RESULT`s —
   * `useQuery` consumers see the new data without re-subscribing.
   *
   * Each close is guarded so one already-closing socket can't abort the sweep.
   *
   * @param options.code   WebSocket close code (default 1012).
   * @param options.reason WebSocket close reason (default 'state-refresh').
   * @returns the number of sockets that were closed.
   */
  disconnectAllSockets(options?: { code?: number; reason?: string }): number {
    const code = options?.code ?? 1012
    const reason = options?.reason ?? 'state-refresh'
    let closed = 0
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(code, reason)
        closed++
      } catch {
        // Socket already closing/closed — skip it, keep sweeping the rest.
      }
    }
    return closed
  }

  /**
   * Get the user attachment for a WebSocket.
   */
  protected getAttachment(ws: WebSocket): UserAttachment | null {
    return ws.deserializeAttachment() as UserAttachment | null
  }

  /**
   * Get all currently connected users.
   */
  protected getConnectedUsers(): UserAttachment[] {
    const users: UserAttachment[] = []
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as UserAttachment | null
      if (attachment) users.push(attachment)
    }
    return users
  }

  /**
   * Send a JSON message to a specific WebSocket.
   *
   * Typed as `ServerMessage` so every room's outbound traffic is
   * compile-checked against the wire protocol contract. Passing
   * `{ type: 'whatever', payload: {...} }` with a non-matching arm fails
   * to compile — that's the whole point of the typed layer. Apps that
   * need to send an app-specific message should override `sendTo` in
   * their subclass with a widened union (`ServerMessage | MyAppMessage`).
   */
  protected sendTo(ws: WebSocket, message: ServerMessage): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message))
      }
    } catch {
      // Ignore send errors on dead sockets
    }
  }

  /**
   * Send binary data to a specific WebSocket.
   */
  protected sendBinaryTo(ws: WebSocket, data: Uint8Array | ArrayBuffer): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    } catch {
      // Ignore send errors on dead sockets
    }
  }

  /**
   * Broadcast a JSON message to all connected WebSockets.
   * Optionally exclude a specific WebSocket (e.g. the sender).
   *
   * See `sendTo` for the reasoning behind typing as `ServerMessage`.
   */
  protected broadcast(message: ServerMessage, exclude?: WebSocket): void {
    const encoded = JSON.stringify(message)
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encoded)
        }
      } catch { /* dead socket */ }
    }
  }

  /**
   * Broadcast binary data to all connected WebSockets.
   */
  protected broadcastBinary(
    data: Uint8Array | ArrayBuffer,
    exclude?: WebSocket
  ): void {
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data)
        }
      } catch { /* dead socket */ }
    }
  }
}
