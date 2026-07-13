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
