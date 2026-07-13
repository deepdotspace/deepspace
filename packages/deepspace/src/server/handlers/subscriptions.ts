/**
 * Subscription handlers for RecordRoom
 *
 * All collections use table-mode storage (c_* tables with typed columns).
 */

import type { ConnectionAttachment } from '../../shared/protocol/types'
import type { Query, RecordResult, SubscribePayload, UnsubscribePayload } from '../../shared/types'
import { MSG } from '../../shared/protocol/constants'
import type { ServerMessage } from '../../shared/protocol/messages'
import {
  type CollectionSchema,
  type PermissionContext,
  SchemaRegistry,
  canRead,
  getRolePermissions,
  resolveColumn,
  buildTableSelect,
  rowToData,
  columnId,
  collectionTableName,
} from '../schemas/registry'
import { SYSTEM_COLLECTIONS } from './yjs'

export interface SubscriptionContext {
  sql: SqlStorage
  schemaRegistry: SchemaRegistry
  state: DurableObjectState // Needed to get all connected WebSockets
  getPermissionContext(): PermissionContext
  /** Typed against `ServerMessage` so outbound broadcasts are
   *  compile-checked against the wire contract. */
  send(ws: WebSocket, message: ServerMessage): void
}

/**
 * Handle a new subscription request.
 *
 * We no longer store subscriptions server-side - broadcasts go to all clients
 * and they filter locally. This avoids hibernation issues.
 */
export function handleSubscribe(
  ctx: SubscriptionContext,
  ws: WebSocket,
  attachment: ConnectionAttachment,
  payload: SubscribePayload
): void {
  const { subscriptionId, query } = payload

  // Execute query and send initial results
  const records = executeQuery(ctx, query, attachment.userId, attachment.role)
  ctx.send(ws, { type: MSG.QUERY_RESULT, payload: { subscriptionId, records } })
}

/**
 * Handle unsubscribe request.
 *
 * Since we no longer store subscriptions server-side, this is a no-op.
 * The client handles unsubscription locally.
 */
export function handleUnsubscribe(
  _ctx: SubscriptionContext,
  _ws: WebSocket,
  _attachment: ConnectionAttachment,
  _payload: UnsubscribePayload
): void {
  // No-op - we don't store subscriptions server-side anymore
}

/**
 * Execute a query and return matching records.
 * All collections use table-mode (c_* tables).
 *
 * `skipUserRbac` lets a server-action caller (i.e. the app itself, via
 * `X-App-Action`) bypass the per-user read filter for parity with the other
 * `tools.*` operations (`get`, `create`, `update`, `remove`).
 */
export function executeQuery(
  ctx: SubscriptionContext,
  query: Query,
  userId: string,
  userRole: string,
  skipUserRbac: boolean = false,
): RecordResult[] {
  const isSystem = SYSTEM_COLLECTIONS.has(query.collection)
  const schema = ctx.schemaRegistry.get(query.collection)

  if (!schema && !isSystem) {
    return []
  }

  if (!schema) {
    // System collection without schema — query the c_* table directly
    return executeSystemQuery(ctx, query)
  }

  return executeTableQuery(ctx, query, schema, userId, userRole, isSystem, skipUserRbac)
}

/**
 * Query a system collection (no schema, just system columns).
 */
function executeSystemQuery(
  ctx: SubscriptionContext,
  query: Query,
): RecordResult[] {
  const tbl = collectionTableName(query.collection)
  let sql = `SELECT _row_id, _created_by, _created_at, _updated_at FROM "${tbl}"`
  const params: unknown[] = []

  sql += ` ORDER BY _created_at DESC`

  if (query.limit) {
    sql += ` LIMIT ?`
    params.push(query.limit)
  }

  try {
    const cursor = ctx.sql.exec(sql, ...params)
    return cursor.toArray().map((row: unknown) => {
      const r = row as { _row_id: string; _created_by: string; _created_at: string; _updated_at: string }
      return {
        recordId: r._row_id,
        data: {},
        createdBy: r._created_by,
        createdAt: r._created_at,
        updatedAt: r._updated_at,
      }
    })
  } catch {
    return []
  }
}

/**
 * Preload the current user's team IDs from the c_team_members collection table.
 * Returns null if no team_members collection schema is registered (non-workspace DOs).
 */
function preloadUserTeamIds(ctx: SubscriptionContext, userId: string): string[] | null {
  const tmSchema = ctx.schemaRegistry.get('team_members')
  if (!tmSchema?.columns?.length) return null

  const cursor = ctx.sql.exec(
    `SELECT col_teamid FROM c_team_members WHERE col_userid = ? AND (col_status = 'active' OR col_status IS NULL)`,
    userId
  )
  return cursor.toArray().map(r => (r as Record<string, unknown>).col_teamid as string)
}

function executeTableQuery(
  ctx: SubscriptionContext,
  query: Query,
  schema: CollectionSchema,
  userId: string,
  userRole: string,
  isSystem: boolean,
  skipUserRbac: boolean = false,
): RecordResult[] {
  const columns = (schema.columns ?? []).map(resolveColumn)
  const perms = getRolePermissions(schema, userRole)

  let sql = buildTableSelect(query.collection, columns)
  const params: unknown[] = []
  const whereClauses: string[] = []

  // SQL pushdown for team-scoped reads: filter at the SQL level instead
  // of fetching all rows and checking team membership per-record.
  // Skipped entirely when the caller is an app action bypassing user RBAC.
  let skipPerRecordCheck = skipUserRbac
  if (!skipUserRbac && schema.teamField && perms.read === 'team') {
    // '_rowId' is a sentinel: the record's own ID is the team ID (e.g. teams table)
    const filterCol = schema.teamField === '_rowId'
      ? '_row_id'
      : (columns.find(c => c.name === schema.teamField)?.id ?? columnId(schema.teamField))
    const teamIds = preloadUserTeamIds(ctx, userId)

    if (teamIds && teamIds.length > 0) {
      const placeholders = teamIds.map(() => '?').join(', ')
      whereClauses.push(`("${filterCol}" IN (${placeholders}) OR _created_by = ?)`)
      params.push(...teamIds, userId)
    } else {
      whereClauses.push(`_created_by = ?`)
      params.push(userId)
    }
    skipPerRecordCheck = true
  }

  if (query.where) {
    for (const [fieldName, value] of Object.entries(query.where)) {
      const colId = columnId(fieldName)
      const col = columns.find(c => c.id === colId || c.name === fieldName)
      if (col) {
        whereClauses.push(`"${col.id}" = ?`)
        params.push(value)
      } else if (fieldName === 'recordId') {
        whereClauses.push(`_row_id = ?`)
        params.push(value)
      } else if (fieldName === 'createdBy') {
        whereClauses.push(`_created_by = ?`)
        params.push(value)
      }
    }
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`
  }

  if (query.orderBy) {
    const dir = query.orderDir === 'asc' ? 'ASC' : 'DESC'
    if (query.orderBy === 'createdAt') {
      sql += ` ORDER BY _created_at ${dir}`
    } else if (query.orderBy === 'updatedAt') {
      sql += ` ORDER BY _updated_at ${dir}`
    } else {
      const colId = columnId(query.orderBy)
      const col = columns.find(c => c.id === colId || c.name === query.orderBy)
      if (col) {
        sql += ` ORDER BY "${col.id}" ${dir}`
      }
    }
  } else {
    sql += ` ORDER BY _created_at DESC`
  }

  if (query.limit) {
    sql += ` LIMIT ?`
    params.push(query.limit)
  }

  const cursor = ctx.sql.exec(sql, ...params)
  const results: RecordResult[] = []

  for (const row of cursor.toArray()) {
    const r = row as { _row_id: string; _created_by: string; _created_at: string; _updated_at: string; [key: string]: unknown }
    const data = rowToData(r, columns)
    const record: RecordResult = {
      recordId: r._row_id,
      data,
      createdBy: r._created_by,
      createdAt: r._created_at,
      updatedAt: r._updated_at,
    }

    if (isSystem || skipPerRecordCheck || canRead(schema, userRole, { data: record.data, createdBy: record.createdBy, recordId: record.recordId }, userId, ctx.getPermissionContext())) {
      results.push(record)
    }
  }

  return results
}

/**
 * Check if a record matches a subscription's query and permissions
 */
export function recordMatchesSubscription(
  record: { recordId: string; data: Record<string, unknown>; createdBy: string },
  collection: string,
  query: Query,
  userId: string,
  userRole: string,
  schema: CollectionSchema,
  ctx: PermissionContext
): boolean {
  // Collection must match
  if (query.collection !== collection) return false

  // Permission check (includes collaborator/team)
  if (!canRead(schema, userRole, { data: record.data, createdBy: record.createdBy, recordId: record.recordId }, userId, ctx)) {
    return false
  }

  // Filter check (equality only)
  if (query.where) {
    for (const [field, value] of Object.entries(query.where)) {
      if (record.data[field] !== value) return false
    }
  }

  return true
}

/**
 * Broadcast a record change to all connected clients who can read it.
 *
 * Instead of matching subscriptions (which are lost on hibernation),
 * we broadcast to ALL clients and include the collection name.
 * The client filters based on its local subscriptions.
 */
export function broadcastChange(
  ctx: SubscriptionContext,
  state: DurableObjectState,
  collection: string,
  record: RecordResult,
  changeType: 'create' | 'update' | 'delete'
): void {
  const isSystem = SYSTEM_COLLECTIONS.has(collection)
  const schema = ctx.schemaRegistry.get(collection)

  if (!schema && !isSystem) return // Schema not loaded yet

  const webSockets = state.getWebSockets()

  for (const ws of webSockets) {
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) continue

    // System collections broadcast to all; others check permissions
    const canBroadcast = isSystem || recordMatchesSubscription(
      record, collection, { collection }, attachment.userId, attachment.role, schema!, ctx.getPermissionContext()
    )

    if (canBroadcast) {
      ctx.send(ws, { type: MSG.RECORD_CHANGE, payload: { collection, record, changeType } })
    }
  }
}
