/**
 * Record operation handlers for RecordRoom (PUT/DELETE)
 *
 * All collections use table-mode storage (c_* tables with typed columns).
 */

import type { ConnectionAttachment } from '../../shared/protocol/types'
import type { RecordResult, PutPayload, DeletePayload } from '../../shared/types'
import type { ToolResult } from '../utils/tools'
import { serverBuild } from '../../shared/protocol/messages'
import {
  type CollectionSchema,
  type ResolvedColumn,
  canCreate,
  canUpdate,
  canDelete,
  canRead,
  checkFieldPermissions,
  SYSTEM_MANAGED_COLUMNS,
  resolveColumn,
  columnId,
  collectionTableName,
  rowToData,
  dataToColumnValues,
  buildTableSelect,
} from '../schemas/registry'
import { broadcastChange, type SubscriptionContext } from './subscriptions'
import { SYSTEM_COLLECTIONS } from './yjs'

export interface RecordContext extends SubscriptionContext {
  state: DurableObjectState
}

/**
 * Get resolved columns for a schema.
 */
function getResolvedColumns(schema: CollectionSchema): ResolvedColumn[] {
  return (schema.columns ?? []).map(resolveColumn)
}

// ============================================================================
// Team Membership Change Detection
// ============================================================================

/**
 * When a team_members record is created/updated/deleted, the affected user's
 * team-scoped subscriptions (teams, tasks, projects, etc.) are stale — the
 * initial query was filtered by their old team list. Send MSG.RESUBSCRIBE to
 * tell the client to re-subscribe all active queries with fresh team data.
 */
function notifyTeamMembershipChange(
  ctx: RecordContext,
  collection: string,
  record: RecordResult,
): void {
  if (collection !== 'team_members') return

  const affectedUserId = record.data.UserId as string
  if (!affectedUserId) return

  const webSockets = ctx.state.getWebSockets()
  for (const ws of webSockets) {
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) continue
    if (attachment.userId === affectedUserId) {
      ctx.send(ws, serverBuild.resubscribe())
    }
  }
}

// ============================================================================
// Row ↔ Data Mapping
// ============================================================================

interface TableRow {
  _row_id: string
  _created_by: string
  _created_at: string
  _updated_at: string
  [key: string]: unknown
}

function tableRowToRecord(
  row: TableRow,
  columns: ResolvedColumn[],
): {
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
} {
  return {
    data: rowToData(row, columns),
    createdBy: row._created_by,
    createdAt: row._created_at,
    updatedAt: row._updated_at,
  }
}

// ============================================================================
// Get Record
// ============================================================================

/**
 * Get a single record from its c_* table.
 */
export function getRecord(
  sql: SqlStorage,
  collection: string,
  recordId: string,
  schema?: CollectionSchema,
): {
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
} | null {
  if (!schema || !schema.columns) {
    // System collections with empty columns — query with just system columns
    const tbl = collectionTableName(collection)
    try {
      const cursor = sql.exec(`SELECT * FROM "${tbl}" WHERE _row_id = ?`, recordId)
      const row = cursor.toArray()[0] as unknown as TableRow | undefined
      if (!row) return null
      return {
        data: {},
        createdBy: row._created_by,
        createdAt: row._created_at,
        updatedAt: row._updated_at,
      }
    } catch {
      return null
    }
  }

  const columns = getResolvedColumns(schema)
  const selectSql = buildTableSelect(collection, columns) + ` WHERE _row_id = ?`
  const cursor = sql.exec(selectSql, recordId)
  const row = cursor.toArray()[0] as unknown as TableRow | undefined
  if (!row) return null
  return tableRowToRecord(row, columns)
}

/**
 * Handle PUT (create/update) record request via WebSocket.
 * Thin wrapper around putRecord() — translates ToolResult errors to WS messages.
 */
export function handlePut(
  ctx: RecordContext,
  ws: WebSocket,
  attachment: ConnectionAttachment,
  payload: PutPayload,
): void {
  const { collection, recordId, data, requestId } = payload
  const result = putRecord(ctx, collection, recordId, data, attachment.userId, attachment.role)

  if (requestId) {
    ctx.send(
      ws,
      result.success
        ? serverBuild.ackSuccess(requestId, recordId)
        : serverBuild.ackFailure(requestId, result.error),
    )
  } else if (!result.success) {
    ctx.send(ws, serverBuild.error(result.error))
  }
}

/**
 * Handle DELETE record request via WebSocket.
 * Thin wrapper around deleteRecord() — translates ToolResult errors to WS messages.
 */
export function handleDelete(
  ctx: RecordContext,
  ws: WebSocket,
  attachment: ConnectionAttachment,
  payload: DeletePayload,
): void {
  const { collection, recordId, requestId } = payload
  const result = deleteRecord(ctx, collection, recordId, attachment.userId, attachment.role)

  if (requestId) {
    ctx.send(
      ws,
      result.success
        ? serverBuild.ackSuccess(requestId)
        : serverBuild.ackFailure(requestId, result.error),
    )
  } else if (!result.success) {
    ctx.send(ws, serverBuild.error(result.error))
  }
}

// ============================================================================
// Shared Record Operations (used by both WebSocket handlers and Tools API)
// ============================================================================

/**
 * Put (create/update) a record. Returns ToolResult instead of sending WS messages.
 * Performs schema validation, RBAC checks, and broadcasts changes.
 *
 * @param skipUserRbac - When true, skip user role checks. Used by server actions
 *   that have already been authorized at the app level.
 * @param systemUpdate - When true, also skip system-managed field stripping.
 *   Used for server-initiated updates to system fields (e.g. user profile sync).
 */
export function putRecord(
  ctx: RecordContext,
  collection: string,
  recordId: string,
  data: Record<string, unknown>,
  userId: string,
  userRole: string,
  skipUserRbac = false,
  systemUpdate = false,
): ToolResult {
  const isSystem = SYSTEM_COLLECTIONS.has(collection)
  const schema = ctx.schemaRegistry.get(collection)

  if (!schema && !isSystem) {
    return { success: false, error: `Schema not registered for collection: ${collection}` }
  }

  if (!schema) {
    return { success: false, error: `Schema not registered for collection: ${collection}` }
  }

  const columns = getResolvedColumns(schema)
  const existing = getRecord(ctx.sql, collection, recordId, schema)
  const isUpdate = existing !== null

  const mergedData = isUpdate ? { ...existing!.data, ...data } : { ...data }

  // Enforce column-level field behaviors
  for (const col of columns) {
    if (col.readonly) continue

    if (!isUpdate) {
      // CREATE: apply defaults, userBound, required checks
      if (col.default !== undefined && mergedData[col.name] === undefined) {
        mergedData[col.name] = col.default
      }
      if (col.userBound) {
        mergedData[col.name] = userId
      }
      if (
        col.required &&
        (mergedData[col.name] === undefined ||
          mergedData[col.name] === null ||
          mergedData[col.name] === '')
      ) {
        return { success: false, error: `Required field '${col.name}' is missing` }
      }
    } else {
      // UPDATE: enforce immutable, preserve userBound
      if (
        col.immutable &&
        data[col.name] !== undefined &&
        data[col.name] !== existing!.data[col.name]
      ) {
        return { success: false, error: `Cannot modify immutable field '${col.name}'` }
      }
      if (col.userBound && data[col.name] !== undefined) {
        mergedData[col.name] = existing!.data[col.name] // preserve original
      }
    }

    // timestampTrigger: auto-set timestamp when trigger field changes
    if (col.timestampTrigger) {
      const { field: triggerField, value: triggerValue } = col.timestampTrigger
      if (!isUpdate) {
        // CREATE: set timestamp if trigger field is present and matches value (if specified)
        if (mergedData[triggerField] !== undefined && mergedData[triggerField] !== null) {
          if (triggerValue === undefined || mergedData[triggerField] === triggerValue) {
            mergedData[col.name] = new Date().toISOString()
          }
        }
      } else {
        // UPDATE: set timestamp if trigger field changed (and optionally to specified value)
        const oldVal = existing!.data[triggerField]
        const newVal = mergedData[triggerField]
        if (newVal !== oldVal) {
          if (triggerValue === undefined || newVal === triggerValue) {
            mergedData[col.name] = new Date().toISOString()
          }
        }
      }
    }
  }

  // Strip system-managed columns (email, name, role, etc.) unless this is a system update
  let finalData = mergedData
  if (!systemUpdate && schema.name === 'users') {
    finalData = { ...mergedData }
    for (const key of SYSTEM_MANAGED_COLUMNS) {
      if (existing?.data[key] !== undefined) {
        finalData[key] = existing.data[key] // preserve existing
      } else {
        delete finalData[key]
      }
    }
  }

  // RBAC checks
  if (!skipUserRbac) {
    const permCtx = ctx.getPermissionContext()
    if (isUpdate) {
      if (!canUpdate(schema, userRole, { ...existing, recordId }, userId, permCtx)) {
        return {
          success: false,
          error: `UPDATE DENIED: role=${userRole}, collection=${collection}`,
        }
      }
      const fieldError = checkFieldPermissions(schema, userRole, finalData, existing.data)
      if (fieldError) {
        return { success: false, error: `FIELD ERROR: ${fieldError}` }
      }
    } else {
      if (!canCreate(schema, userRole)) {
        return {
          success: false,
          error: `CREATE DENIED: role=${userRole}, collection=${collection}`,
        }
      }
    }
  }

  const colValues = dataToColumnValues(finalData, columns)
  const now = new Date().toISOString()
  const tbl = collectionTableName(collection)

  // Enforce uniqueOn constraint before INSERT
  if (!isUpdate && schema.uniqueOn && schema.uniqueOn.length > 0) {
    const uniqueWhere = schema.uniqueOn.map((fieldName) => {
      const colSqlId = columnId(fieldName)
      return `"${colSqlId}" = ?`
    })
    const uniqueParams = schema.uniqueOn.map((fieldName) => {
      const val = finalData[fieldName]
      return val !== undefined ? val : null
    })
    const existing = ctx.sql.exec(
      `SELECT _row_id FROM "${tbl}" WHERE ${uniqueWhere.join(' AND ')} LIMIT 1`,
      ...uniqueParams,
    )
    if (existing.toArray().length > 0) {
      const fields = schema.uniqueOn.map((f) => `${f}=${finalData[f] ?? 'null'}`).join(', ')
      return {
        success: false,
        error: `Duplicate: a record with ${fields} already exists in ${collection}`,
      }
    }
  }

  if (isUpdate) {
    const setClauses: string[] = [`_updated_at = ?`]
    const params: unknown[] = [now]
    for (const [colId, val] of Object.entries(colValues)) {
      setClauses.push(`"${colId}" = ?`)
      params.push(val)
    }
    params.push(recordId)
    ctx.sql.exec(`UPDATE "${tbl}" SET ${setClauses.join(', ')} WHERE _row_id = ?`, ...params)
  } else {
    const colIds = Object.keys(colValues)
    const allCols = [
      '_row_id',
      '_created_by',
      '_created_at',
      '_updated_at',
      ...colIds.map((c) => `"${c}"`),
    ]
    const placeholders = allCols.map(() => '?').join(', ')
    const params = [recordId, userId, now, now, ...colIds.map((c) => colValues[c])]
    ctx.sql.exec(`INSERT INTO "${tbl}" (${allCols.join(', ')}) VALUES (${placeholders})`, ...params)
  }

  // Read back to get computed columns and canonical values
  const saved = getRecord(ctx.sql, collection, recordId, schema)!
  const record: RecordResult = {
    recordId,
    data: saved.data,
    createdBy: saved.createdBy,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  }
  broadcastChange(ctx, ctx.state, collection, record, isUpdate ? 'update' : 'create')
  notifyTeamMembershipChange(ctx, collection, record)

  return { success: true, data: { recordId, record } }
}

/**
 * Delete a record. Returns ToolResult instead of sending WS messages.
 * Performs RBAC check and broadcasts the deletion.
 *
 * @param skipUserRbac - When true, skip user role checks. Used by server actions.
 */
export function deleteRecord(
  ctx: RecordContext,
  collection: string,
  recordId: string,
  userId: string,
  userRole: string,
  skipUserRbac = false,
): ToolResult {
  const isSystem = SYSTEM_COLLECTIONS.has(collection)
  const schema = ctx.schemaRegistry.get(collection)

  if (!schema && !isSystem) {
    return { success: false, error: `Schema not registered for collection: ${collection}` }
  }

  const existing = getRecord(ctx.sql, collection, recordId, schema)
  if (!existing) {
    return { success: false, error: 'Record not found' }
  }

  if (
    !skipUserRbac &&
    schema &&
    !canDelete(schema, userRole, { ...existing, recordId }, userId, ctx.getPermissionContext())
  ) {
    return { success: false, error: `DELETE DENIED: role=${userRole}, collection=${collection}` }
  }

  const tbl = collectionTableName(collection)
  ctx.sql.exec(`DELETE FROM "${tbl}" WHERE _row_id = ?`, recordId)

  const record: RecordResult = {
    recordId,
    data: existing.data,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
  }
  broadcastChange(ctx, ctx.state, collection, record, 'delete')
  notifyTeamMembershipChange(ctx, collection, record)

  return { success: true, data: { deleted: true } }
}

/**
 * Read a single record with RBAC check. Returns ToolResult.
 *
 * @param skipUserRbac - When true, skip user role checks. Used by server actions.
 */
export function readRecord(
  ctx: RecordContext,
  collection: string,
  recordId: string,
  userId: string,
  userRole: string,
  skipUserRbac = false,
): ToolResult {
  const isSystem = SYSTEM_COLLECTIONS.has(collection)
  const schema = ctx.schemaRegistry.get(collection)

  if (!schema && !isSystem) {
    return { success: false, error: `Schema not registered for collection: ${collection}` }
  }

  const existing = getRecord(ctx.sql, collection, recordId, schema)
  if (!existing) {
    return { success: false, error: 'Record not found' }
  }

  if (
    !skipUserRbac &&
    schema &&
    !canRead(schema, userRole, { ...existing, recordId }, userId, ctx.getPermissionContext())
  ) {
    return { success: false, error: `READ DENIED: role=${userRole}, collection=${collection}` }
  }

  const record: RecordResult = {
    recordId,
    data: existing.data,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
  }

  return { success: true, data: { record } }
}
