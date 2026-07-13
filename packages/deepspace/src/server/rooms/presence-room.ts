/**
 * PresenceRoom — Ephemeral presence-tracking Durable Object.
 *
 * Extends BaseRoom. No SQLite — purely in-memory presence state.
 * Tracks who is present in a given scope (canvas, doc, thread, etc.)
 * and broadcasts join/leave/state-update events to all connected peers.
 *
 * Each scope ID maps to its own DO instance. Clients connect via
 * /ws/presence/:scopeId and receive real-time presence for that scope.
 *
 * Peers can attach arbitrary state (cursor position, typing indicator,
 * viewport, selection, etc.) via MSG.PRESENCE_UPDATE.
 *
 * Message types: presence.*
 */

/// <reference types="@cloudflare/workers-types" />

import { BaseRoom, type UserAttachment } from './base-room'
import { MSG } from '../../shared/protocol/constants'

// ============================================================================
// Types
// ============================================================================

export interface PresencePeer {
  userId: string
  userName: string
  userEmail: string
  userImageUrl?: string
  joinedAt: string
  /** Arbitrary per-user state (cursor, typing, viewport, etc.) */
  state: Record<string, unknown>
}

interface PresenceAttachment extends UserAttachment {
  joinedAt: string
}

// ============================================================================
// PresenceRoom
// ============================================================================

export class PresenceRoom<E = Record<string, unknown>> extends BaseRoom<E> {
  private peers: Map<string, PresencePeer> = new Map()
  private peerSockets: Map<string, WebSocket> = new Map()

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env)
  }

  /**
   * Durable Objects can hibernate and clear heap while Cloudflare keeps
   * WebSocket connections. Deserialize attachments from already-connected
   * sockets so `peers` matches reality before we send PRESENCE_SYNC.
   */
  private hydratePeersFromLiveSockets(connectingWs: WebSocket): void {
    for (const existing of this.state.getWebSockets()) {
      if (existing === connectingWs) continue
      const att = existing.deserializeAttachment() as PresenceAttachment | null
      if (!att?.userId) continue
      if (this.peers.has(att.userId)) continue

      const joinedAt =
        typeof att.joinedAt === 'string' ? att.joinedAt : new Date().toISOString()

      const recovered: PresencePeer = {
        userId: att.userId,
        userName: att.userName,
        userEmail: att.userEmail,
        userImageUrl: att.userImageUrl,
        joinedAt,
        state: {},
      }
      this.peers.set(att.userId, recovered)
      this.peerSockets.set(att.userId, existing)
    }
  }

  // --------------------------------------------------------------------------
  // BaseRoom Lifecycle
  // --------------------------------------------------------------------------

  protected onConnect(ws: WebSocket, user: UserAttachment): PresenceAttachment {
    this.hydratePeersFromLiveSockets(ws)

    const now = new Date().toISOString()

    const peer: PresencePeer = {
      userId: user.userId,
      userName: user.userName,
      userEmail: user.userEmail,
      userImageUrl: user.userImageUrl,
      joinedAt: now,
      state: {},
    }

    // Send existing peers to the new connection (before adding self)
    this.sendTo(ws, {
      type: MSG.PRESENCE_SYNC,
      payload: { peers: Array.from(this.peers.values()) },
    })

    // Now add self and notify others
    this.peers.set(user.userId, peer)
    this.peerSockets.set(user.userId, ws)
    this.broadcast({ type: MSG.PRESENCE_JOIN, payload: { peer } }, ws)

    const attachment: PresenceAttachment = {
      ...user,
      joinedAt: now,
    }

    return attachment
  }

  protected async onMessage(
    ws: WebSocket,
    user: UserAttachment,
    message: { type: string; [key: string]: unknown }
  ): Promise<void> {
    const { type, payload } = message as { type: string; payload: Record<string, unknown> }

    switch (type) {
      case MSG.PRESENCE_UPDATE: {
        let peer = this.peers.get(user.userId)
        if (!peer) {
          const att = user as PresenceAttachment
          const joinedAt =
            typeof att.joinedAt === 'string' ? att.joinedAt : new Date().toISOString()
          peer = {
            userId: user.userId,
            userName: user.userName,
            userEmail: user.userEmail,
            userImageUrl: user.userImageUrl,
            joinedAt,
            state: {},
          }
          this.peers.set(user.userId, peer)
          this.peerSockets.set(user.userId, ws)
        }

        // Merge the incoming state into the peer's current state
        peer.state = { ...peer.state, ...payload }
        this.peers.set(user.userId, peer)

        // Broadcast the update to all other peers
        this.broadcast(
          {
            type: MSG.PRESENCE_UPDATE,
            payload: { userId: user.userId, state: peer.state },
          },
          ws,
        )
        break
      }

      default:
        this.sendTo(ws, { type: MSG.ERROR, payload: { error: `Unknown presence message type: ${type}` } })
    }
  }

  protected onDisconnect(ws: WebSocket, user: UserAttachment): void {
    this.peers.delete(user.userId)
    this.peerSockets.delete(user.userId)
    this.broadcast({ type: MSG.PRESENCE_LEAVE, payload: { userId: user.userId } }, ws)
  }
}
