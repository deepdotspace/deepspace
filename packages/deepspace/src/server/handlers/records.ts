/**
 * Record operation handlers for RecordRoom (PUT/DELETE)
 *
 * All collections use table-mode storage (c_* tables with typed columns).
 */

import type { ConnectionAttachment } from '../../shared/protocol/types'
import type { RecordResult, PutPayload, DeletePayload } from '../../shared/types'
import type { ToolResult } from '../utils/tools'
import { serverBuild } from '../../shared/protocol/messages'
import { RECORD_NOT_FOUND } from '../../shared/protocol/constants'
import {
  type CollectionSchema,
  type ResolvedColumn,
  canCreate,
  canUpdate,
  canDelete,
  canRead,
  checkFieldPermissions,
  checkUnclaimedOwnerTransition,
  SYSTEM_ASSIGNED_COLUMNS,
  SYSTEM_MANAGED_COLUMNS,
  coerceValue,
  resolveColumn,
  columnId,
  collectionTableName,
  rowToData,
  dataToColumnValues,
  buildTableSelect,
} from '../schemas/registry'
import { broadcastChange, resolveCollection, type SubscriptionContext } from './subscriptions'

export interface RecordContext extends SubscriptionContext {
  state: DurableObjectState
}

/**
 * Get resolved columns for a schema.
 */
function getResolvedColumns(schema: CollectionSchema): ResolvedColumn[] {
  return (schema.columns ?? []).map(resolveColumn)
}

/** Refusal text for a record write that tries to set a system-assigned column. */
function systemManagedColumnError(column: string, isUpdate: boolean): string {
  const roleHint =
    column === 'role' ? ', or the admin-gated useUsers().setRole() to change a role' : ''
  // On an update there is a current value to echo, and echoing it succeeds. On
  // a create there is none, and no value at all is accepted — pointing at a
  // "current value" would send the caller looking for something that does not
  // exist. The row itself is registration's to make.
  const remedy = isUpdate
    ? `Re-sending the current value of '${column}' unchanged is accepted and ignored.`
    : `A users row is created by registration, so no value for '${column}' is accepted here — omit it.`
  return (
    `FIELD ERROR: '${column}' is system-managed and cannot be set by a record write — ` +
    `nothing was written. Use tools.registerUser({ userId, isAdmin })${roleHint}. ${remedy}`
  )
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
  const resolved = resolveCollection(ctx, collection)
  if (!resolved.ok) return { success: false, error: resolved.error }

  // A write needs declared columns, so a schema-less system collection is not
  // writable through this path even though it resolves.
  const schema = resolved.schema
  if (!schema) {
    return { success: false, error: `Schema not registered for collection: ${collection}` }
  }

  const columns = getResolvedColumns(schema)
  for (const col of columns) {
    if (col.id !== col.name && Object.hasOwn(data, col.id)) {
      return {
        success: false,
        error: `FIELD ERROR: physical column id '${col.id}' is not a writable field; use '${col.name}'`,
      }
    }
  }
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

  const finalData = { ...mergedData }

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
    } else {
      if (!canCreate(schema, userRole)) {
        return {
          success: false,
          error: `CREATE DENIED: role=${userRole}, collection=${collection}`,
        }
      }
    }

    // Check only caller-supplied fields. Defaults, user-bound values, and
    // timestamp triggers are server-owned and must not trip writableFields.
    const fieldError = checkFieldPermissions(
      schema,
      userRole,
      data,
      isUpdate ? existing.data : undefined,
    )
    if (fieldError) {
      return { success: false, error: `FIELD ERROR: ${fieldError}` }
    }

    const ownerError = checkUnclaimedOwnerTransition(schema, userRole, finalData, userId)
    if (ownerError) {
      return { success: false, error: `FIELD ERROR: ${ownerError}` }
    }
  }

  // System-managed columns on `users` belong to registerUser, not to ordinary
  // record writes, so none of them is ever written from here. How a supplied
  // value is answered depends on whether the caller could have chosen it:
  //
  //  - SYSTEM_ASSIGNED (email, name, imageUrl, role): a different value is a
  //    change the caller means and will not get. Refuse loudly instead of
  //    returning `{ success: true }` over a silently discarded write.
  //  - SYSTEM_MAINTAINED (createdAt, lastSeenAt): the server moves these on
  //    its own without broadcasting, so a stale echo is an artifact of
  //    read-modify-write, not an attempted change. Preserve silently.
  //
  // "Different" means different *once written*: `coerceValue` is what decides
  // the stored column, and it maps undefined, null and '' alike to NULL. Those
  // three spellings are one state, so comparing anything but the coerced values
  // refuses writes that would not change a byte.
  if (!systemUpdate && schema.name === 'users') {
    for (const col of columns) {
      if (!SYSTEM_MANAGED_COLUMNS.has(col.name)) continue
      const current = existing?.data[col.name]
      if (
        SYSTEM_ASSIGNED_COLUMNS.has(col.name) &&
        Object.hasOwn(data, col.name) &&
        coerceValue(data[col.name], col.storage, col.interpretation) !==
          coerceValue(current, col.storage, col.interpretation)
      ) {
        return { success: false, error: systemManagedColumnError(col.name, isUpdate) }
      }
      if (current !== undefined) finalData[col.name] = current // preserve existing
      else delete finalData[col.name]
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
  const resolved = resolveCollection(ctx, collection)
  if (!resolved.ok) return { success: false, error: resolved.error }
  const schema = resolved.schema

  const existing = getRecord(ctx.sql, collection, recordId, schema)
  if (!existing) {
    return { success: false, error: RECORD_NOT_FOUND }
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
  const resolved = resolveCollection(ctx, collection)
  if (!resolved.ok) return { success: false, error: resolved.error }
  const schema = resolved.schema

  const existing = getRecord(ctx.sql, collection, recordId, schema)
  if (!existing) {
    return { success: false, error: RECORD_NOT_FOUND }
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
