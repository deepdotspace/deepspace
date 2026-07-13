/**
 * YjsRoom — Lightweight Durable Object for collaborative Yjs documents.
 * Extends BaseRoom for WebSocket/connection infrastructure.
 *
 * Unlike RecordRoom (schemas, RBAC, queries, user state), YjsRoom is
 * purpose-built for Yjs: sync, relay, persist. One DO per document.
 *
 * Architecture (SOTA for Yjs + Cloudflare DOs):
 * - Auth verified at the worker edge, role passed to DO via URL params
 * - DO is a thin Yjs sync relay: receive → apply → persist → broadcast
 * - Viewers can observe but not write; members/admins can write
 * - State persisted as a single binary blob in SQLite
 *
 * Uses the shared yjs-protocol.ts encoding utilities — no duplication.
 */

/// <reference types="@cloudflare/workers-types" />

import * as Y from 'yjs'
import { BaseRoom, type UserAttachment } from './base-room'
import {
  MSG_SYNC,
  MSG_AWARENESS,
  MSG_SYNC_STEP1,
  MSG_SYNC_STEP2,
  MSG_SYNC_UPDATE,
  createEncoder,
  createDecoder,
  toUint8Array,
  writeVarUint,
  writeVarUint8Array,
  readVarUint,
  readVarUint8Array,
} from '../../shared/protocol/yjs'

// ============================================================================
// Connection attachment (extends UserAttachment, survives hibernation)
// ============================================================================

interface YjsAttachment extends UserAttachment {
  role: string
  canWrite: boolean
  awarenessClientId: number | null
}

interface AwarenessEntry {
  clock: number
  stateBytes: Uint8Array
}

// ============================================================================
// YjsRoom Durable Object
// ============================================================================

export class YjsRoom<E = Record<string, unknown>> extends BaseRoom<E> {
  private doc: Y.Doc | null = null
  private initialized = false
  private awarenessStates = new Map<number, AwarenessEntry>()

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env)
  }

  // --------------------------------------------------------------------------
  // Initialization & persistence
  // --------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS yjs_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        doc BLOB NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  private getDoc(): Y.Doc {
    if (this.doc) return this.doc

    this.ensureInitialized()
    this.doc = new Y.Doc()

    // Load persisted state
    const rows = this.sql.exec('SELECT doc FROM yjs_state WHERE id = 1').toArray()
    if (rows.length > 0 && rows[0].doc) {
      Y.applyUpdate(this.doc, new Uint8Array(rows[0].doc as ArrayBuffer))
    }

    // Auto-save on every update
    this.doc.on('update', () => this.persistDoc())

    return this.doc
  }

  private persistDoc(): void {
    if (!this.doc) return
    const state = Y.encodeStateAsUpdate(this.doc)
    const now = new Date().toISOString()
    this.sql.exec(
      `INSERT INTO yjs_state (id, doc, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET doc = ?, updated_at = ?`,
      state,
      now,
      state,
      now,
    )
  }

  // --------------------------------------------------------------------------
  // BaseRoom Lifecycle Hooks
  // --------------------------------------------------------------------------

  protected onConnect(ws: WebSocket, user: UserAttachment): YjsAttachment {
    const role = ((user as Record<string, unknown>).role as string) ?? 'viewer'
    const canWrite = role === 'member' || role === 'admin'

    const attachment: YjsAttachment = {
      ...user,
      role,
      canWrite,
      awarenessClientId: null,
    }

    // Initial sync: send our state vector (STEP1) + full state (STEP2)
    const doc = this.getDoc()

    const step1 = createEncoder()
    writeVarUint(step1, MSG_SYNC)
    writeVarUint(step1, MSG_SYNC_STEP1)
    writeVarUint8Array(step1, Y.encodeStateVector(doc))
    ws.send(toUint8Array(step1).buffer)

    const fullState = Y.encodeStateAsUpdate(doc)
    if (fullState.length > 1) {
      const step2 = createEncoder()
      writeVarUint(step2, MSG_SYNC)
      writeVarUint(step2, MSG_SYNC_STEP2)
      writeVarUint8Array(step2, fullState)
      ws.send(toUint8Array(step2).buffer)
    }

    // Tell client their write access
    ws.send(JSON.stringify({ type: 'auth', canWrite }))
    this.sendAwarenessSnapshot(ws)

    return attachment
  }

  protected onMessage(
    _ws: WebSocket,
    _user: UserAttachment,
    _message: { type: string; [key: string]: unknown },
  ): void {
    // YjsRoom only handles binary messages; JSON messages are ignored
    // (ping/pong handled by auto-response)
  }

  protected onBinaryMessage(ws: WebSocket, user: UserAttachment, data: ArrayBuffer): void {
    const bytes = new Uint8Array(data)
    const decoder = createDecoder(bytes)
    const messageType = readVarUint(decoder)

    if (messageType === MSG_SYNC) {
      this.handleSync(ws, decoder, bytes)
    } else if (messageType === MSG_AWARENESS) {
      this.handleAwareness(ws, decoder, bytes)
    }
  }

  protected onDisconnect(ws: WebSocket, _user: UserAttachment): void {
    const attachment = ws.deserializeAttachment() as YjsAttachment | null
    if (attachment?.awarenessClientId == null) return

    const clientId = attachment.awarenessClientId
    const prevClock = this.awarenessStates.get(clientId)?.clock ?? 0
    this.awarenessStates.delete(clientId)

    const msg = this.encodeAwarenessMessage([
      {
        clientId,
        clock: prevClock + 1,
        stateBytes: new TextEncoder().encode('null'),
      },
    ])
    for (const peer of this.state.getWebSockets()) {
      if (peer === ws) continue
      try {
        peer.send(msg.buffer)
      } catch {
        /* dead socket */
      }
    }
  }

  // --------------------------------------------------------------------------
  // Sync protocol
  // --------------------------------------------------------------------------

  private handleSync(
    ws: WebSocket,
    decoder: { data: Uint8Array; pos: number },
    rawMessage: Uint8Array,
  ): void {
    const syncType = readVarUint(decoder)
    const doc = this.getDoc()

    switch (syncType) {
      case MSG_SYNC_STEP1: {
        const clientStateVector = readVarUint8Array(decoder)
        const diff = Y.encodeStateAsUpdate(doc, clientStateVector)
        const enc = createEncoder()
        writeVarUint(enc, MSG_SYNC)
        writeVarUint(enc, MSG_SYNC_STEP2)
        writeVarUint8Array(enc, diff)
        ws.send(toUint8Array(enc).buffer)
        break
      }
      case MSG_SYNC_STEP2:
      case MSG_SYNC_UPDATE: {
        const attachment = ws.deserializeAttachment() as YjsAttachment | null
        if (!attachment?.canWrite) return
        const update = readVarUint8Array(decoder)
        Y.applyUpdate(doc, update, 'remote')
        this.broadcastRaw(ws, rawMessage)
        break
      }
    }
  }

  private handleAwareness(
    ws: WebSocket,
    decoder: { data: Uint8Array; pos: number },
    rawMessage: Uint8Array,
  ): void {
    const updates = this.readAwarenessUpdates(decoder)
    if (updates.length === 0) return

    const attachment = ws.deserializeAttachment() as YjsAttachment | null
    if (attachment && attachment.awarenessClientId === null) {
      attachment.awarenessClientId = updates[0].clientId
      ws.serializeAttachment(attachment)
    }

    for (const update of updates) {
      const existing = this.awarenessStates.get(update.clientId)
      if (existing && existing.clock >= update.clock) continue

      if (new TextDecoder().decode(update.stateBytes) === 'null') {
        this.awarenessStates.delete(update.clientId)
      } else {
        this.awarenessStates.set(update.clientId, {
          clock: update.clock,
          stateBytes: update.stateBytes,
        })
      }
    }

    this.broadcastRaw(ws, rawMessage)
  }

  private readAwarenessUpdates(decoder: {
    data: Uint8Array
    pos: number
  }): Array<AwarenessEntry & { clientId: number }> {
    const update = readVarUint8Array(decoder)
    const updateDecoder = createDecoder(update)
    const count = readVarUint(updateDecoder)
    const updates: Array<AwarenessEntry & { clientId: number }> = []

    for (let i = 0; i < count; i++) {
      const clientId = readVarUint(updateDecoder)
      const clock = readVarUint(updateDecoder)
      const stateBytes = readVarUint8Array(updateDecoder)
      updates.push({ clientId, clock, stateBytes })
    }

    return updates
  }

  private encodeAwarenessMessage(
    updates: Array<AwarenessEntry & { clientId: number }>,
  ): Uint8Array {
    const inner = createEncoder()
    writeVarUint(inner, updates.length)
    for (const update of updates) {
      writeVarUint(inner, update.clientId)
      writeVarUint(inner, update.clock)
      writeVarUint8Array(inner, update.stateBytes)
    }

    const outer = createEncoder()
    writeVarUint(outer, MSG_AWARENESS)
    writeVarUint8Array(outer, toUint8Array(inner))
    return toUint8Array(outer)
  }

  private sendAwarenessSnapshot(ws: WebSocket): void {
    if (this.awarenessStates.size === 0) return

    const updates = Array.from(this.awarenessStates, ([clientId, entry]) => ({
      clientId,
      clock: entry.clock,
      stateBytes: entry.stateBytes,
    }))
    const msg = this.encodeAwarenessMessage(updates)
    try {
      ws.send(msg.buffer)
    } catch {
      /* dead socket */
    }
  }

  // --------------------------------------------------------------------------
  // Broadcasting
  // --------------------------------------------------------------------------

  private broadcastRaw(sender: WebSocket, rawMessage: Uint8Array): void {
    for (const ws of this.state.getWebSockets()) {
      if (ws === sender) continue
      try {
        ws.send(rawMessage.buffer)
      } catch {
        /* dead socket */
      }
    }
  }
}
