/**
 * User management handlers for RecordRoom
 *
 * Users are stored in the c_users table (table-mode).
 * System-managed fields (email, name, role, etc.) can only be set by registerUser().
 */

import type { ConnectionAttachment } from '../../shared/protocol/types'
import type { CollectionSchema, SetRolePayload } from '../../shared/types'
import { MSG, isAnonymousUserId } from '../../shared/protocol/constants'
import {
  canRead,
  getRolePermissions,
  type PermissionContext,
  type User,
  type ResolvedColumn,
  SchemaRegistry,
  resolveColumn,
  buildTableSelect,
  rowToData,
} from '../schemas/registry'
import { putRecord, type RecordContext } from './records'

export interface UserContext {
  sql: SqlStorage
  state: DurableObjectState
  schemaRegistry: SchemaRegistry
  getPermissionContext(): PermissionContext
  send(ws: WebSocket, message: { type: string; payload: unknown }): void
}

/**
 * User data stored in the users collection.
 * Core fields are system-managed, apps can add their own fields.
 */
interface UserRecord {
  // System-managed fields
  email: string
  name: string
  imageUrl?: string
  role: string
  createdAt: string
  lastSeenAt: string
  // App-specific fields are dynamic
  [key: string]: unknown
}

interface TableRow {
  _row_id: string
  _created_by: string
  _created_at: string
  _updated_at: string
  [key: string]: unknown
}

/**
 * Get resolved columns for the users schema.
 */
function getUsersColumns(schemaRegistry: SchemaRegistry): ResolvedColumn[] {
  const schema = schemaRegistry.get('users')
  return (schema?.columns ?? []).map(resolveColumn)
}

/**
 * Convert a c_users row to User type (core fields only).
 */
function rowToUser(row: TableRow, columns: ResolvedColumn[]): User {
  const data = rowToData(row, columns)
  return {
    id: row._row_id,
    email: (data.email as string) || '',
    name: (data.name as string) || '',
    imageUrl: data.imageUrl as string | undefined,
    role: (data.role as string) || 'viewer',
    createdAt: (data.createdAt as string) || row._created_at,
    lastSeenAt: (data.lastSeenAt as string) || row._updated_at,
  }
}

/**
 * Convert a c_users row to full UserRecord (including app-specific fields).
 */
function rowToUserRecord(row: TableRow, columns: ResolvedColumn[]): UserRecord {
  const data = rowToData(row, columns)
  return {
    email: (data.email as string) || '',
    name: (data.name as string) || '',
    imageUrl: data.imageUrl as string | undefined,
    role: (data.role as string) || 'viewer',
    createdAt: (data.createdAt as string) || row._created_at,
    lastSeenAt: (data.lastSeenAt as string) || row._updated_at,
    ...data,
  }
}

/**
 * Get a single user by ID from the c_users table.
 */
export function getUser(sql: SqlStorage, userId: string, schemaRegistry?: SchemaRegistry): User | null {
  // If we have the schema registry, use table-mode columns for proper field mapping
  if (schemaRegistry) {
    const columns = getUsersColumns(schemaRegistry)
    const selectSql = buildTableSelect('users', columns) + ` WHERE _row_id = ?`
    const cursor = sql.exec(selectSql, userId)
    const row = cursor.toArray()[0] as unknown as TableRow | undefined
    if (!row) return null
    return rowToUser(row, columns)
  }
  // Fallback: direct column query with known core column names
  const cursor = sql.exec(
    `SELECT * FROM c_users WHERE _row_id = ?`,
    userId
  )
  const row = cursor.toArray()[0] as unknown as TableRow | undefined
  if (!row) return null
  return {
    id: row._row_id,
    email: (row.col_email as string) || '',
    name: (row.col_name as string) || '',
    imageUrl: row.col_imageurl as string | undefined,
    role: (row.col_role as string) || 'viewer',
    createdAt: (row.col_createdat as string) || row._created_at,
    lastSeenAt: (row.col_lastseenat as string) || row._updated_at,
  }
}

/**
 * Get full user record including app-specific fields.
 */
export function getUserRecord(sql: SqlStorage, userId: string, schemaRegistry?: SchemaRegistry): { data: UserRecord; createdBy: string } | null {
  const columns = schemaRegistry ? getUsersColumns(schemaRegistry) : []
  const selectSql = columns.length > 0
    ? buildTableSelect('users', columns) + ` WHERE _row_id = ?`
    : `SELECT * FROM c_users WHERE _row_id = ?`
  const cursor = sql.exec(selectSql, userId)
  const row = cursor.toArray()[0] as unknown as TableRow | undefined
  if (!row) return null

  return {
    data: columns.length > 0 ? rowToUserRecord(row, columns) : {
      email: (row.col_email as string) || '',
      name: (row.col_name as string) || '',
      imageUrl: row.col_imageurl as string | undefined,
      role: (row.col_role as string) || 'viewer',
      createdAt: (row.col_createdat as string) || row._created_at,
      lastSeenAt: (row.col_lastseenat as string) || row._updated_at,
    },
    createdBy: row._created_by,
  }
}

/**
 * Get all users from the c_users table.
 */
export function getAllUsers(sql: SqlStorage, schemaRegistry?: SchemaRegistry): User[] {
  const columns = schemaRegistry ? getUsersColumns(schemaRegistry) : []
  const selectSql = columns.length > 0
    ? buildTableSelect('users', columns) + ` ORDER BY _created_at DESC`
    : `SELECT * FROM c_users ORDER BY _created_at DESC`
  const cursor = sql.exec(selectSql)
  return cursor.toArray().map((row: unknown) => {
    const r = row as TableRow
    if (columns.length > 0) return rowToUser(r, columns)
    return {
      id: r._row_id,
      email: (r.col_email as string) || '',
      name: (r.col_name as string) || '',
      imageUrl: r.col_imageurl as string | undefined,
      role: (r.col_role as string) || 'viewer',
      createdAt: (r.col_createdat as string) || r._created_at,
      lastSeenAt: (r.col_lastseenat as string) || r._updated_at,
    }
  })
}

/**
 * Get all user records including app-specific fields.
 */
export function getAllUserRecords(sql: SqlStorage, schemaRegistry?: SchemaRegistry): Array<{ recordId: string; data: UserRecord; createdBy: string }> {
  const columns = schemaRegistry ? getUsersColumns(schemaRegistry) : []
  const selectSql = columns.length > 0
    ? buildTableSelect('users', columns) + ` ORDER BY _created_at DESC`
    : `SELECT * FROM c_users ORDER BY _created_at DESC`
  const cursor = sql.exec(selectSql)
  return cursor.toArray().map((row: unknown) => {
    const r = row as TableRow
    return {
      recordId: r._row_id,
      createdBy: r._created_by,
      data: columns.length > 0 ? rowToUserRecord(r, columns) : {
        email: (r.col_email as string) || '',
        name: (r.col_name as string) || '',
        imageUrl: r.col_imageurl as string | undefined,
        role: (r.col_role as string) || 'viewer',
        createdAt: (r.col_createdat as string) || r._created_at,
        lastSeenAt: (r.col_lastseenat as string) || r._updated_at,
      },
    }
  })
}

/**
 * Register or update a user in the c_users table.
 *
 * This is the ONLY way to set system-managed fields (email, name, role, etc.).
 * Normal mutations via handlePut will reject changes to system-managed fields.
 *
 * Role derivation (in order of priority):
 * 1. isAdmin=true (global admin, canvas owner, or app owner) → always 'admin'
 * 2. Existing role in users collection (preserved)
 * 3. Default role (configurable per-app, defaults to 'member')
 *
 * This allows each miniapp to define its own role hierarchy while
 * ensuring admins and owners always have full access.
 */
export async function registerUser(
  sql: SqlStorage,
  userId: string,
  name: string,
  email: string,
  imageUrl: string | undefined,
  isAdmin: boolean,
  defaultRole: string = 'viewer',
  schemaRegistry?: SchemaRegistry
): Promise<User> {
  const now = new Date().toISOString()

  // Get existing user record
  const existing = getUserRecord(sql, userId, schemaRegistry)

  // Derive role:
  // 1. DeepSpace global admins are ALWAYS admin
  // 2. Otherwise, preserve existing role
  // 3. Fall back to default role
  let role: string
  if (isAdmin) {
    role = 'admin'
  } else if (existing?.data.role) {
    role = existing.data.role
  } else {
    role = defaultRole
  }

  if (existing) {
    // Update existing user - only update system-managed columns.
    // When connecting with token-only (no profile), name='Anonymous' and email=''.
    // Don't overwrite real values with defaults.
    const updatedEmail = email || existing.data.email
    const updatedName = (name && name !== 'Anonymous') ? name : existing.data.name
    const updatedImageUrl = imageUrl ?? existing.data.imageUrl

    sql.exec(
      `UPDATE c_users SET col_email = ?, col_name = ?, col_imageurl = ?, col_role = ?, col_lastseenat = ?, _updated_at = ? WHERE _row_id = ?`,
      updatedEmail, updatedName, updatedImageUrl ?? null, role, now, now, userId
    )

    return {
      id: userId,
      email: updatedEmail,
      name: updatedName,
      imageUrl: updatedImageUrl,
      role,
      createdAt: existing.data.createdAt,
      lastSeenAt: now
    }
  }

  // Create new user record
  sql.exec(
    `INSERT INTO c_users (_row_id, _created_by, _created_at, _updated_at, col_email, col_name, col_imageurl, col_role, col_createdat, col_lastseenat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    userId, userId, now, now, email, name, imageUrl ?? null, role, now, now
  )

  return { id: userId, email, name, imageUrl, role, createdAt: now, lastSeenAt: now }
}

type UserRow = { recordId: string; data: UserRecord; createdBy: string }
type PublicIdentity = {
  id: string
  name: string
  imageUrl?: string
  role: string
  /** Presence is a public fact — `usePresence().isOnline` derives from it, so
   *  dropping it from the projection left presence dead for every non-admin. */
  lastSeenAt: string
}

/**
 * What one caller may see of the roster. Anonymous callers and roles whose
 * users policy is switched off (`read: false`, or no `read` at all — the same
 * "deny" `canRead` uses) get nothing: that is a policy statement, not a row
 * filter. Admins get whole rows — email and any app-defined column — so their
 * read still goes through the schema's row policy. Everyone else gets the
 * public-identity projection of the whole roster: a row-level policy (`'own'`,
 * `'team'`, a predicate) guards full-row reads on the records/query path, and
 * nothing it protects survives this projection — applying it here left every
 * member of a `read: 'own'` room (every `chat:*` room, since messaging ships
 * no users schema) with a roster of just themselves and peers rendered as
 * "Unknown".
 */
function rosterFor(
  ctx: UserContext,
  schema: CollectionSchema,
  records: UserRow[],
  publicRoster: PublicIdentity[],
  userId: string,
  role: string,
): Array<Record<string, unknown>> {
  // No identity at all (the tools API without `X-User-Id`) is the same
  // statement as an anonymous socket: not someone the directory is for.
  if (!userId || isAnonymousUserId(userId)) return []
  if (role === 'admin') {
    const permissionContext = ctx.getPermissionContext()
    return records
      .filter((record) => canRead(schema, 'admin', record, userId, permissionContext))
      .map((record) => ({ id: record.recordId, ...record.data }))
  }
  if (!getRolePermissions(schema, role).read) return []
  // `roster: 'read-policy'` opts a tenant/team-scoped app out of the shared
  // roster: only the rows the caller's read policy grants, still projected.
  if (schema.roster === 'read-policy') {
    const permissionContext = ctx.getPermissionContext()
    const readable = new Set(
      records
        .filter((record) => canRead(schema, role, record, userId, permissionContext))
        .map((record) => record.recordId),
    )
    return publicRoster.filter((user) => readable.has(user.id))
  }
  return publicRoster
}

function publicIdentities(records: UserRow[]): PublicIdentity[] {
  return records.map(({ recordId, data }) => ({
    id: recordId,
    name: data.name,
    ...(data.imageUrl ? { imageUrl: data.imageUrl } : {}),
    role: data.role,
    lastSeenAt: data.lastSeenAt,
  }))
}

/**
 * The roster this caller may see, read fresh.
 *
 * The socket's `user.list` request and the `user.list` tool are one question
 * asked over two transports, so both answer from here. A tool that read the
 * users table directly handed every member the directory the room's users
 * policy — `read: false`, `roster: 'read-policy'` — exists to withhold.
 *
 * Public rooms support anonymous sockets, but that must not turn the users
 * table into a public directory; a room with no users schema has none.
 */
export function rosterForCaller(
  ctx: UserContext,
  userId: string,
  role: string,
): Array<Record<string, unknown>> {
  const schema = ctx.schemaRegistry.get('users')
  if (!schema) return []
  const records = getAllUserRecords(ctx.sql, ctx.schemaRegistry)
  return rosterFor(ctx, schema, records, publicIdentities(records), userId, role)
}

/** Handle user list requests without bypassing the users collection's privacy boundary. */
export function handleUserList(
  ctx: UserContext,
  ws: WebSocket,
  attachment: ConnectionAttachment
): void {
  const users = rosterForCaller(ctx, attachment.userId, attachment.role)
  ctx.send(ws, { type: MSG.USER_LIST, payload: { users } })
}

/**
 * Push the current roster to every connected socket (except `except`). The
 * client asks for `user.list` once per connection and never again, so anything
 * that changes what the roster shows — a user registering, a rename, a new
 * avatar, a role change — must push, or every open tab keeps rendering the
 * peer it has never seen as "Unknown" until it reconnects. The roster is read
 * and projected once; each socket then gets its own view of it.
 */
export function broadcastUserList(
  ctx: UserContext,
  except?: WebSocket | ReadonlySet<WebSocket>,
): void {
  const schema = ctx.schemaRegistry.get('users')
  if (!schema) return
  const skip = except instanceof Set ? except : new Set(except ? [except] : [])
  const records = getAllUserRecords(ctx.sql, ctx.schemaRegistry)
  const publicRoster = publicIdentities(records)
  for (const other of ctx.state.getWebSockets()) {
    if (skip.has(other)) continue
    const attachment = other.deserializeAttachment() as ConnectionAttachment | null
    if (!attachment) continue
    ctx.send(other, {
      type: MSG.USER_LIST,
      payload: {
        users: rosterFor(ctx, schema, records, publicRoster, attachment.userId, attachment.role),
      },
    })
  }
}

/**
 * Handle user profile update.
 *
 * Called when the client's profile loads after the initial WS connection.
 * Updates the user's name/email/imageUrl in c_users and pushes the updated
 * roster to every connected client so names refresh in real time.
 */
export interface UserUpdatePayload {
  name?: string
  email?: string
  imageUrl?: string
}

export function handleUserUpdate(
  ctx: RecordContext,
  _ws: WebSocket,
  attachment: ConnectionAttachment,
  payload: UserUpdatePayload
): void {
  const existing = getUserRecord(ctx.sql, attachment.userId, ctx.schemaRegistry)
  if (!existing) return

  const data: Record<string, unknown> = { lastSeenAt: new Date().toISOString() }
  if (payload.name && payload.name !== 'Anonymous') data.name = payload.name
  if (payload.email) data.email = payload.email
  if (payload.imageUrl !== undefined) data.imageUrl = payload.imageUrl || undefined

  // systemUpdate=true bypasses system-managed field stripping so we can
  // write to name/email/imageUrl. broadcastChange fires automatically,
  // updating any useQuery('users') subscriptions on connected clients; the
  // `user.list` roster (`useUsers()`) is a separate request/response and
  // needs the explicit push.
  putRecord(ctx, 'users', attachment.userId, data, attachment.userId, 'admin', true, true)
  const rosterChanged =
    (data.name !== undefined && data.name !== existing.data.name) ||
    (data.imageUrl !== undefined && data.imageUrl !== existing.data.imageUrl)
  if (rosterChanged) broadcastUserList(ctx)
}

/**
 * Handle set role request (admin only).
 * Updates the role field in the c_users table.
 */
export async function handleSetRole(
  ctx: UserContext,
  ws: WebSocket,
  attachment: ConnectionAttachment,
  payload: SetRolePayload
): Promise<void> {
  if (attachment.role !== 'admin') {
    ctx.send(ws, { type: MSG.ERROR, payload: { error: 'Admin access required' } })
    return
  }

  const existing = getUserRecord(ctx.sql, payload.userId, ctx.schemaRegistry)
  if (!existing) {
    ctx.send(ws, { type: MSG.ERROR, payload: { error: 'User not found' } })
    return
  }

  // Update role in the c_users table
  const now = new Date().toISOString()
  ctx.sql.exec(
    `UPDATE c_users SET col_role = ?, _updated_at = ? WHERE _row_id = ?`,
    payload.role, now, payload.userId
  )

  // Close the changed user's live sockets. Reconnect runs the ordinary role
  // lookup again, so no connection keeps permissions from before the change.
  const closing = new Set<WebSocket>()
  for (const otherWs of ctx.state.getWebSockets()) {
    const otherAttachment = otherWs.deserializeAttachment() as ConnectionAttachment | null
    if (otherAttachment?.userId !== payload.userId) continue
    closing.add(otherWs)
    try {
      otherWs.close(1008, 'role-changed')
    } catch {
      // Already closing.
    }
  }

  // Then push the roster to everyone else — one read, each socket its own
  // projection — so their tabs see the new role instead of holding the stale
  // one until reconnect. The closed sockets are skipped by identity rather
  // than trusted to drop the frame.
  broadcastUserList(ctx, closing)
}
