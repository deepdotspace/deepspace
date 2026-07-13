/**
 * Yjs collaborative editing handlers for RecordRoom
 */

import * as Y from 'yjs'
import type { ConnectionAttachment } from '../../shared/protocol/types'
import type { YjsDocKey, YjsJoinPayload, YjsLeavePayload } from '../../shared/types'
import { MSG_YJS_SYNC, MSG_YJS_AWARENESS, MSG } from '../../shared/protocol/constants'
import {
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
import {
  type CollectionSchema,
  type PermissionContext,
  SchemaRegistry,
  canRead,
  canUpdate,
  collectionTableName,
} from '../schemas/registry'
import { getRecord } from './records'

/** Parse a Yjs doc key (collection:recordId:fieldName). recordId may contain colons. */
function parseYjsDocKey(docKey: YjsDocKey): { collection: string; recordId: string; fieldName: string } | null {
  const firstColon = docKey.indexOf(':')
  const lastColon = docKey.lastIndexOf(':')
  if (firstColon === -1 || lastColon === -1 || firstColon === lastColon) return null
  return {
    collection: docKey.slice(0, firstColon),
    recordId: docKey.slice(firstColon + 1, lastColon),
    fieldName: docKey.slice(lastColon + 1),
  }
}

// ============================================================================
// System Collections (permissive, no schema required)
// ============================================================================

/** Collections that bypass schema checks (permissive access) */
export const SYSTEM_COLLECTIONS = new Set([
  'canvas-settings',
])

/**
 * Schemas for system collections.
 * These have empty columns arrays — they only use system columns
 * (_row_id, _created_by, _created_at, _updated_at).
 * Yjs data is stored in the yjs_docs table, not in the record itself.
 */
export const SYSTEM_COLLECTION_SCHEMAS: CollectionSchema[] = [
  {
    name: 'canvas-settings',
    columns: [],
    permissions: {
      '*': { read: true, create: true, update: true, delete: true },
    },
  },
]

export interface YjsContext {
  sql: SqlStorage
  state: DurableObjectState
  yjsDocs: Map<YjsDocKey, Y.Doc>
  schemaRegistry: SchemaRegistry
  getPermissionContext(): PermissionContext
  send(ws: WebSocket, message: { type: string; payload: unknown }): void
  sendBinary(ws: WebSocket, data: Uint8Array): void
}

/**
 * Create a Yjs doc key from collection, recordId, and fieldName
 */
export function getYjsDocKey(collection: string, recordId: string, fieldName: string): YjsDocKey {
  return `${collection}:${recordId}:${fieldName}`
}

/**
 * Get or create a Y.Doc for a record field.
 * Loads from database if exists, creates new if not.
 */
export async function getOrCreateYjsDoc(
  ctx: YjsContext,
  docKey: YjsDocKey
): Promise<Y.Doc> {
  // Return cached doc if available
  let doc = ctx.yjsDocs.get(docKey)
  if (doc) return doc

  // Create new doc
  doc = new Y.Doc()

  // Try to load from database
  const row = ctx.sql.exec(
    `SELECT state FROM yjs_docs WHERE doc_key = ?`,
    docKey
  ).toArray()[0] as { state: ArrayBuffer } | undefined

  if (row?.state) {
    try {
      Y.applyUpdate(doc, new Uint8Array(row.state))
    } catch (e) {
      console.error(`Failed to load Yjs doc ${docKey}:`, e)
    }
  }

  // Set up auto-save on updates
  const saveDoc = (): void => {
    saveYjsDoc(ctx.sql, docKey, doc!)
  }
  doc.on('update', saveDoc)

  ctx.yjsDocs.set(docKey, doc)
  return doc
}

/**
 * Save Yjs doc state to database.
 */
export function saveYjsDoc(sql: SqlStorage, docKey: YjsDocKey, doc: Y.Doc): void {
  const state = Y.encodeStateAsUpdate(doc)
  const now = new Date().toISOString()
  sql.exec(
    `INSERT INTO yjs_docs (doc_key, state, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(doc_key) DO UPDATE SET state = ?, updated_at = ?`,
    docKey, state, now, state, now
  )
}

/**
 * Handle request to join Yjs sync for a record field.
 * System collections (see SYSTEM_COLLECTIONS) are permissive; others require schema.
 */
export async function handleYjsJoin(
  ctx: YjsContext,
  ws: WebSocket,
  attachment: ConnectionAttachment,
  payload: YjsJoinPayload
): Promise<void> {
  const { collection, recordId, fieldName } = payload
  const isSystem = SYSTEM_COLLECTIONS.has(collection)

  const schema = ctx.schemaRegistry.get(collection)
  let record = getRecord(ctx.sql, collection, recordId, schema)
  let hasWriteAccess = isSystem // System collections always have write access

  if (isSystem) {
    // Auto-create record for system collections (table-mode)
    if (!record) {
      const now = new Date().toISOString()
      if (schema) {
        const tbl = collectionTableName(collection)
        ctx.sql.exec(
          `INSERT OR IGNORE INTO "${tbl}" (_row_id, _created_by, _created_at, _updated_at) VALUES (?, ?, ?, ?)`,
          recordId, attachment.userId, now, now
        )
      }
      record = getRecord(ctx.sql, collection, recordId, schema)
    }
  } else {
    // Regular collections: require schema and record
    if (!schema) {
      ctx.send(ws, { type: MSG.ERROR, payload: { error: `Schema not registered for collection: ${collection}` } })
      return
    }
    if (!record) {
      ctx.send(ws, { type: MSG.ERROR, payload: { error: 'Record not found' } })
      return
    }
    const permCtx = ctx.getPermissionContext()
    const recordWithId = { ...record, recordId }
    if (!canRead(schema, attachment.role, recordWithId, attachment.userId, permCtx)) {
      ctx.send(ws, { type: MSG.ERROR, payload: { error: 'Permission denied' } })
      return
    }
    hasWriteAccess = canUpdate(schema, attachment.role, recordWithId, attachment.userId, permCtx)
  }

  // Get or create Yjs doc and subscribe
  const docKey = getYjsDocKey(collection, recordId, fieldName)
  const doc = await getOrCreateYjsDoc(ctx, docKey)

  if (!attachment.yjsSubscriptions.some(s => 
    s.collection === collection && s.recordId === recordId && s.fieldName === fieldName
  )) {
    attachment.yjsSubscriptions.push({ collection, recordId, fieldName })
    ws.serializeAttachment(attachment)
  }

  // Send sync messages
  const docKeyBytes = new TextEncoder().encode(docKey)
  const encoder1 = createEncoder()
  writeVarUint(encoder1, MSG_YJS_SYNC)
  writeVarUint8Array(encoder1, docKeyBytes)
  writeVarUint(encoder1, MSG_SYNC_STEP1)
  writeVarUint8Array(encoder1, Y.encodeStateVector(doc))
  ctx.sendBinary(ws, toUint8Array(encoder1))

  const fullState = Y.encodeStateAsUpdate(doc)
  if (fullState.length > 1) {
    const encoder2 = createEncoder()
    writeVarUint(encoder2, MSG_YJS_SYNC)
    writeVarUint8Array(encoder2, docKeyBytes)
    writeVarUint(encoder2, MSG_SYNC_STEP2)
    writeVarUint8Array(encoder2, fullState)
    ctx.sendBinary(ws, toUint8Array(encoder2))
  }

  ctx.send(ws, { type: MSG.YJS_JOIN, payload: { collection, recordId, fieldName, canWrite: hasWriteAccess } })
}

/**
 * Handle request to leave Yjs sync for a record field.
 */
export function handleYjsLeave(
  ws: WebSocket,
  attachment: ConnectionAttachment,
  payload: YjsLeavePayload
): void {
  const { collection, recordId, fieldName } = payload

  // Remove from subscriptions
  attachment.yjsSubscriptions = attachment.yjsSubscriptions.filter(s =>
    !(s.collection === collection && s.recordId === recordId && s.fieldName === fieldName)
  )
  ws.serializeAttachment(attachment)

  // TODO: If no more subscribers for this doc, consider unloading it from memory
}

/**
 * Handle binary Yjs sync messages from clients.
 * 
 * Protocol:
 * - MSG_SYNC_STEP1: Client sends state vector → Server responds with SYNC_STEP2 (diff)
 * - MSG_SYNC_STEP2/UPDATE: Client sends update → Server applies and broadcasts
 */
export async function handleYjsBinaryMessage(
  ctx: YjsContext,
  ws: WebSocket,
  attachment: ConnectionAttachment,
  data: Uint8Array
): Promise<void> {
  const decoder = createDecoder(data)
  const messageType = readVarUint(decoder)

  // Handle awareness messages (ephemeral — relay only, no persistence)
  if (messageType === MSG_YJS_AWARENESS) {
    const docKeyBytes = readVarUint8Array(decoder)
    const docKey = new TextDecoder().decode(docKeyBytes) as YjsDocKey
    const payload = readVarUint8Array(decoder)

    const parsed = parseYjsDocKey(docKey)
    if (!parsed) return
    const { collection, recordId, fieldName } = parsed

    const isSubscribed = attachment.yjsSubscriptions.some(s =>
      s.collection === collection && s.recordId === recordId && s.fieldName === fieldName
    )
    if (!isSubscribed) return

    // Capture the client's awareness clientId for disconnect cleanup
    if (attachment.awarenessClientId == null) {
      try {
        const pd = createDecoder(payload)
        const count = readVarUint(pd)
        if (count > 0) {
          attachment.awarenessClientId = readVarUint(pd)
          ws.serializeAttachment(attachment)
        }
      } catch { /* best-effort */ }
    }

    broadcastAwareness(ctx, docKey, payload, ws)
    return
  }

  if (messageType !== MSG_YJS_SYNC) return

  // Parse doc key (format: collection:recordId:fieldName)
  // Note: recordId may contain colons (e.g., "shape:notepad-xxx")
  // So we split on first colon for collection, last colon for fieldName
  const docKeyBytes = readVarUint8Array(decoder)
  const docKey = new TextDecoder().decode(docKeyBytes) as YjsDocKey

  const parsed = parseYjsDocKey(docKey)
  if (!parsed) return
  const { collection, recordId, fieldName } = parsed

  // Verify subscription
  const isSubscribed = attachment.yjsSubscriptions.some(s =>
    s.collection === collection && s.recordId === recordId && s.fieldName === fieldName
  )
  if (!isSubscribed) return

  // Load doc from SQLite if not in memory (handles DO hibernation wake-up)
  const doc = await getOrCreateYjsDoc(ctx, docKey)

  const syncType = readVarUint(decoder)

  switch (syncType) {
    case MSG_SYNC_STEP1: {
      // Client requests sync - respond with diff based on their state vector
      const clientStateVector = readVarUint8Array(decoder)
      const diff = Y.encodeStateAsUpdate(doc, clientStateVector)
      
      const encoder = createEncoder()
      writeVarUint(encoder, MSG_YJS_SYNC)
      writeVarUint8Array(encoder, new TextEncoder().encode(docKey))
      writeVarUint(encoder, MSG_SYNC_STEP2)
      writeVarUint8Array(encoder, diff)
      ctx.sendBinary(ws, toUint8Array(encoder))
      break
    }

    case MSG_SYNC_STEP2:
    case MSG_SYNC_UPDATE: {
      // Client sends update - system collections permissive, others check permission
      if (!SYSTEM_COLLECTIONS.has(collection)) {
        const syncSchema = ctx.schemaRegistry.get(collection)
        if (!syncSchema) return
        const record = getRecord(ctx.sql, collection, recordId, syncSchema)
        if (!record) return
        if (!canUpdate(syncSchema, attachment.role, { ...record, recordId }, attachment.userId, ctx.getPermissionContext())) return
      }

      const update = readVarUint8Array(decoder)
      Y.applyUpdate(doc, update, 'client')
      saveYjsDoc(ctx.sql, docKey, doc)
      broadcastYjsUpdate(ctx, docKey, update, ws)
      break
    }
  }
}

/**
 * Broadcast a Yjs update to all subscribers of a doc, except the sender.
 */
export function broadcastYjsUpdate(
  ctx: YjsContext,
  docKey: YjsDocKey,
  update: Uint8Array,
  excludeWs: WebSocket | null
): void {
  const parsed = parseYjsDocKey(docKey)
  if (!parsed) return
  const { collection, recordId, fieldName } = parsed

  // Build message once
  const encoder = createEncoder()
  writeVarUint(encoder, MSG_YJS_SYNC)
  writeVarUint8Array(encoder, new TextEncoder().encode(docKey))
  writeVarUint(encoder, MSG_SYNC_UPDATE)
  writeVarUint8Array(encoder, update)
  const message = toUint8Array(encoder)

  // Send to all other subscribers
  for (const ws of ctx.state.getWebSockets()) {
    if (ws === excludeWs) continue
    
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) continue

    const isSubscribed = attachment.yjsSubscriptions.some(s =>
      s.collection === collection && s.recordId === recordId && s.fieldName === fieldName
    )
    
    if (isSubscribed) {
      ctx.sendBinary(ws, message)
    }
  }
}

/**
 * Broadcast an awareness update to all subscribers of a doc, except the sender.
 * Awareness is ephemeral (cursors, presence) — NOT persisted to SQLite.
 */
export function broadcastAwareness(
  ctx: YjsContext,
  docKey: YjsDocKey,
  payload: Uint8Array,
  excludeWs: WebSocket | null
): void {
  const parsed = parseYjsDocKey(docKey)
  if (!parsed) return
  const { collection, recordId, fieldName } = parsed

  // Build message once
  const encoder = createEncoder()
  writeVarUint(encoder, MSG_YJS_AWARENESS)
  writeVarUint8Array(encoder, new TextEncoder().encode(docKey))
  writeVarUint8Array(encoder, payload)
  const message = toUint8Array(encoder)

  // Send to all other subscribers
  for (const ws of ctx.state.getWebSockets()) {
    if (ws === excludeWs) continue

    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) continue

    const isSubscribed = attachment.yjsSubscriptions.some(s =>
      s.collection === collection && s.recordId === recordId && s.fieldName === fieldName
    )

    if (isSubscribed) {
      ctx.sendBinary(ws, message)
    }
  }
}

/**
 * Broadcast awareness removal for a disconnected client.
 *
 * When a WebSocket closes without a clean leave, other clients still
 * show the disconnected user's cursor. This constructs a null-state
 * awareness update and broadcasts it to remaining subscribers.
 */
export function broadcastAwarenessRemoval(
  ctx: YjsContext,
  attachment: ConnectionAttachment,
): void {
  const clientId = attachment.awarenessClientId
  if (clientId == null || attachment.yjsSubscriptions.length === 0) return

  // Build null-state awareness payload: [1][clientId][highClock]["null"]
  const payloadEncoder = createEncoder()
  writeVarUint(payloadEncoder, 1)
  writeVarUint(payloadEncoder, clientId)
  writeVarUint(payloadEncoder, 0xFFFFFF) // high clock to override any prior state
  writeVarUint8Array(payloadEncoder, new TextEncoder().encode('null'))
  const removalPayload = toUint8Array(payloadEncoder)

  for (const sub of attachment.yjsSubscriptions) {
    const docKey = getYjsDocKey(sub.collection, sub.recordId, sub.fieldName)
    broadcastAwareness(ctx, docKey, removalPayload, null)
  }
}
