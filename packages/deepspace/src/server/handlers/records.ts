/**
 * Record operation handlers for RecordRoom (PUT/DELETE)
 *
 * All collections use table-mode storage (c_* tables with typed columns).
 */

import type { ConnectionAttachment } from '../../shared/protocol/types'
import type { RecordResult, PutPayload, DeletePayload } from '../../shared/types'
import type { ToolResult } from '../utils/tools'
import { DEFAULT_DELETE_WHERE_LIMIT, MAX_DELETE_WHERE_LIMIT } from '../utils/tools'
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
  epochSeconds,
} from '../schemas/registry'
import {
  broadcastChange,
  executeQuery,
  resolveCollection,
  type SubscriptionContext,
} from './subscriptions'

export interface RecordContext extends SubscriptionContext {
  state: DurableObjectState
}

/**
 * Get resolved columns for a schema.
 */
function getResolvedColumns(schema: CollectionSchema): ResolvedColumn[] {
  return (schema.columns ?? []).map(resolveColumn)
}

/**
 * "Now", in the representation this column's own `storage` declares: epoch
 * seconds for a `number` column, an ISO string for a `text` one.
 *
 * The trigger used to write ISO whatever the storage was, and `coerceValue`
 * then ran `parseFloat('2026-08-18T…')` over it — so a `storage: 'number'`
 * column silently stored the year, `2026`, with tsc, eslint and the schema
 * lint all clean. Writing the declared representation removes the failure
 * mode instead of warning about it.
 */
function triggerTimestamp(col: ResolvedColumn): string | number {
  return col.storage === 'number' ? epochSeconds() : new Date().toISOString()
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
 * @param updateOnly - When true, an absent recordId is refused instead of
 *   created. `records.update`'s mode: updates never create.
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
  updateOnly = false,
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
  if (updateOnly && !isUpdate) {
    return {
      success: false,
      error: `records.update: no record "${recordId}" in ${collection} — updates never create; use records.create.`,
    }
  }

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
            mergedData[col.name] = triggerTimestamp(col)
          }
        }
      } else {
        // UPDATE: set timestamp if trigger field changed (and optionally to specified value)
        const oldVal = existing!.data[triggerField]
        const newVal = mergedData[triggerField]
        if (newVal !== oldVal) {
          if (triggerValue === undefined || newVal === triggerValue) {
            mergedData[col.name] = triggerTimestamp(col)
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
  // the stored column, and it maps undefined and null alike to NULL — the two
  // spellings of "absent" are one state, so comparing anything but the coerced
  // values refuses writes that would not change a byte. `''` is not one of
  // them on a text column: it is a value, and setting a system-assigned column
  // to it is a change the caller means and will not get.
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
      if (current !== undefined)
        finalData[col.name] = current // preserve existing
      else delete finalData[col.name]
    }
  }

  const colValues = dataToColumnValues(finalData, columns)
  const now = new Date().toISOString()
  const tbl = collectionTableName(collection)

  // Check the same resolved columns and coerced values as the UNIQUE index so
  // every write path returns a normal ToolResult instead of leaking a SQLite
  // constraint exception. Updates exclude the row being written.
  if (schema.uniqueOn && schema.uniqueOn.length > 0) {
    const uniqueColumns = schema.uniqueOn.map((fieldName) => {
      const id = columns.find((column) => column.name === fieldName)?.id ?? columnId(fieldName)
      return { id, value: colValues[id] ?? null }
    })
    const uniqueWhere = uniqueColumns.map(({ id }) => `"${id}" = ?`)
    const uniqueParams = uniqueColumns.map(({ value }) => value)
    if (isUpdate) uniqueParams.push(recordId)
    const conflict = ctx.sql.exec(
      `SELECT _row_id FROM "${tbl}" WHERE ${uniqueWhere.join(' AND ')}${isUpdate ? ' AND _row_id <> ?' : ''} LIMIT 1`,
      ...uniqueParams,
    )
    if (conflict.toArray().length > 0) {
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
 * The one `where` validator for the tools API's filtered reads and deletes.
 * `executeQuery` is lenient — a key that names no column is silently dropped
 * — which for a delete truncates and for a read over-returns (a typo'd
 * filter hands the whole readable collection back with `success: true`, and
 * an assistant or action then reasons over it as the filtered set). A `where`
 * must be a plain object; every key must be `recordId`, `createdBy`, or a
 * schema column; every value a primitive (equality only). `null` = nothing to
 * refuse.
 *
 * The shape check lives here rather than at each caller because an array
 * `where` degrades differently at every one of them: `[]` passed the query
 * path's emptiness test and filtered nothing, `['a']` was reported as an
 * unknown field named "0", and only `deleteWhere` named the real problem.
 *
 * `schema` is undefined only for a schemaless system collection — and its
 * query path (`executeSystemQuery`) ignores `where` entirely, so ANY filter
 * there would over-return the whole collection as if filtered. Refuse every
 * non-empty `where` on it and say why.
 */
export function refuseUnknownWhere(
  collection: string,
  schema: CollectionSchema | undefined,
  where: unknown,
): ToolResult | null {
  const columns = (schema?.columns ?? []).map(resolveColumn)
  const filterable = ['recordId', 'createdBy', ...columns.map((c) => c.name)]
  if (typeof where !== 'object' || where === null || Array.isArray(where)) {
    const got = where === null ? 'null' : Array.isArray(where) ? 'an array' : typeof where
    return {
      success: false,
      error:
        `where for "${collection}" must be an object of field=value pairs, not ${got} — ` +
        `filterable fields: ${filterable.join(', ')}`,
    }
  }
  if (!schema && Object.keys(where).length > 0) {
    return {
      success: false,
      error: `"${collection}" has no schema, so it has no filterable fields — query it without \`where\``,
    }
  }
  const unknown = Object.keys(where).filter(
    (key) =>
      key !== 'recordId' &&
      key !== 'createdBy' &&
      !columns.some((c) => c.id === columnId(key) || c.name === key),
  )
  if (unknown.length > 0) {
    return {
      success: false,
      error: `Unknown field(s) in where for "${collection}": ${unknown.join(', ')} — filterable fields: ${filterable.join(', ')}`,
    }
  }
  const nonPrimitive = Object.entries(where).filter(([, v]) => v !== null && typeof v === 'object')
  if (nonPrimitive.length > 0) {
    return {
      success: false,
      error: `where values must be primitives (equality only): ${nonPrimitive.map(([k]) => k).join(', ')}`,
    }
  }
  return null
}

/**
 * Delete every record matching `where`, capped at one bounded page.
 *
 * The batch primitive behind cascading deletes: a caller that deleted row by
 * row spent one DO subrequest per row and ran out of subrequest budget on a
 * large set, orphaning the rest. One call handles a page; the caller repeats
 * it while `deleted` equals the page size (each page really removes rows, so
 * the loop terminates).
 *
 * Authorization is exactly `records.delete`'s: every matched record is checked
 * with `canDelete` *before* anything is removed, so a denied row refuses the
 * whole page rather than leaving a half-applied batch.
 *
 * `where` is validated strictly here because `executeQuery` is lenient — it
 * silently drops a key that names no column, and ignores `where` altogether on
 * a schemaless system collection. A read that ignores a filter over-returns; a
 * delete that ignores one truncates. So every key must name a real field
 * (`recordId`, `createdBy`, or a schema column), the collection must have a
 * schema, and `limit` must be a finite number — anything else is refused, and
 * collection-wide truncation is not reachable through this tool.
 *
 * @param skipUserRbac - When true, skip user role checks. Used by server actions.
 */
export function deleteWhere(
  ctx: RecordContext,
  collection: string,
  where: unknown,
  limit: unknown,
  userId: string,
  userRole: string,
  skipUserRbac = false,
): ToolResult {
  const resolved = resolveCollection(ctx, collection)
  if (!resolved.ok) return { success: false, error: resolved.error }
  const schema = resolved.schema
  if (!schema) {
    return {
      success: false,
      error: `records.deleteWhere: collection "${collection}" has no schema, so it has no filterable fields — delete its rows by recordId with records.delete`,
    }
  }

  const whereRefusal = refuseUnknownWhere(collection, schema, where)
  if (whereRefusal) return whereRefusal
  if (Object.keys(where as Record<string, unknown>).length === 0) {
    return {
      success: false,
      error: 'Missing required param: where (must match at least one field)',
    }
  }

  if (limit !== undefined && !(typeof limit === 'number' && Number.isFinite(limit))) {
    return { success: false, error: 'limit must be a finite number' }
  }
  const page = Math.min(
    Math.max(1, Math.floor(limit ?? DEFAULT_DELETE_WHERE_LIMIT)),
    MAX_DELETE_WHERE_LIMIT,
  )
  // Candidate selection is storage-only. A delete permission must not inherit
  // the role's read permission; every candidate is authorized exactly once by
  // canDelete below, matching records.delete.
  const matched = executeQuery(
    ctx,
    { collection, where: where as Record<string, unknown>, limit: page },
    userId,
    userRole,
    true,
  )

  if (!skipUserRbac) {
    const permCtx = ctx.getPermissionContext()
    for (const record of matched) {
      if (!canDelete(schema, userRole, record, userId, permCtx)) {
        return {
          success: false,
          error: `DELETE DENIED: role=${userRole}, collection=${collection}`,
        }
      }
    }
  }

  let deleted = 0
  for (const record of matched) {
    // Authorization for the whole page completed above. Do not run read or
    // delete policy a second time while applying the already-approved set.
    if (deleteRecord(ctx, collection, record.recordId, userId, userRole, true).success) {
      deleted++
    }
  }
  if (deleted < matched.length) {
    // A short page must mean "no more matches", never "some deletes failed" —
    // a drain loop reading it as exhaustion would silently orphan the rest.
    return {
      success: false,
      error: `Deleted ${deleted} of ${matched.length} matched record(s) in "${collection}"; the rest failed — retry`,
    }
  }
  return { success: true, data: { deleted } }
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
