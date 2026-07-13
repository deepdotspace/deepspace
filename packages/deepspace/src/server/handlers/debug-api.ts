/**
 * HTTP Debug API handlers for RecordRoom
 */

import * as Y from 'yjs'
import type { ConnectionAttachment } from '../../shared/protocol/types'
import type { Query, YjsDocKey } from '../../shared/types'
import {
  resolveColumn,
  buildTableSelect,
  rowToData,
  collectionTableName,
} from '../schemas/registry'
import { executeQuery, type SubscriptionContext } from './subscriptions'
import { getAllUsers, getUser } from './users'
import { handleToolsRequest } from './tools-api'

export interface DebugApiContext extends SubscriptionContext {
  state: DurableObjectState
  yjsDocs: Map<YjsDocKey, Y.Doc>
  sendBinary: (ws: WebSocket, data: Uint8Array) => void
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
}

/**
 * Handle HTTP API requests (for debugging)
 */
export async function handleApiRequest(
  ctx: DebugApiContext,
  request: Request,
  url: URL
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  const path = url.pathname.replace('/api/', '')

  // Tools API endpoints
  if (path.startsWith('tools/')) {
    return handleToolsRequest(ctx, request, path)
  }

  // Debug status endpoint
  if (path === 'debug/status') {
    return handleDebugStatus(ctx)
  }

  // Debug SQL - run arbitrary SQL queries
  if (path === 'debug/sql') {
    return handleDebugSql(ctx, request, url)
  }

  // Debug user-role by email endpoint
  if (path === 'debug/user-role') {
    return handleDebugUserRole(ctx, url)
  }

  // Debug set-role endpoint — POST { email, role } or { userId, role }
  if (path === 'debug/set-role' && request.method === 'POST') {
    return handleDebugSetRole(ctx, request)
  }

  // Debug records endpoint
  if (path.startsWith('debug/records/')) {
    return handleDebugRecords(ctx, path)
  }

  // Debug query endpoint
  if (path === 'debug/query') {
    return handleDebugQuery(ctx, url)
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS })
}

/**
 * GET /api/debug/user-role - Get user role info by email or userId
 *
 * Usage:
 *   /api/debug/user-role?email=ctc@gmail.com
 *   /api/debug/user-role?userId=user_39JIhFoZkRsPtj5u3dprEOYKgVR
 */
function handleDebugUserRole(ctx: DebugApiContext, url: URL): Response {
  const email = url.searchParams.get('email')
  const userId = url.searchParams.get('userId')

  if (!email && !userId) {
    return Response.json({ error: 'email or userId parameter required' }, { status: 400, headers: CORS_HEADERS })
  }

  const users = getAllUsers(ctx.sql, ctx.schemaRegistry)

  const user = userId
    ? users.find(u => u.id === userId)
    : users.find(u => u.email === email)

  if (!user) {
    return Response.json({
      error: `User not found`,
      registeredUsers: users.map(u => ({ id: u.id, email: u.email, role: u.role })),
    }, { status: 404, headers: CORS_HEADERS })
  }

  return Response.json({
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  }, { headers: CORS_HEADERS })
}

/**
 * POST /api/debug/set-role - Change a user's role
 *
 * Body: { email: string, role: string } or { userId: string, role: string }
 *
 * Usage:
 *   POST /api/debug/set-role { "email": "ctc@gmail.com", "role": "viewer" }
 *   POST /api/debug/set-role { "userId": "user_39JIh...", "role": "admin" }
 */
async function handleDebugSetRole(ctx: DebugApiContext, request: Request): Promise<Response> {
  const body = await request.json() as { email?: string; userId?: string; role?: string }

  if (!body.role) {
    return Response.json({ error: 'role is required' }, { status: 400, headers: CORS_HEADERS })
  }
  if (!body.email && !body.userId) {
    return Response.json({ error: 'email or userId is required' }, { status: 400, headers: CORS_HEADERS })
  }

  const users = getAllUsers(ctx.sql, ctx.schemaRegistry)
  const user = body.userId
    ? users.find(u => u.id === body.userId)
    : users.find(u => u.email === body.email)

  if (!user) {
    return Response.json({
      error: 'User not found',
      registeredUsers: users.map(u => ({ id: u.id, email: u.email, role: u.role })),
    }, { status: 404, headers: CORS_HEADERS })
  }

  // Update role in c_users table
  const now = new Date().toISOString()
  ctx.sql.exec(
    `UPDATE c_users SET col_role = ?, _updated_at = ? WHERE _row_id = ?`,
    body.role, now, user.id
  )

  return Response.json({
    userId: user.id,
    email: user.email,
    previousRole: user.role,
    newRole: body.role,
  }, { headers: CORS_HEADERS })
}

/**
 * GET /api/debug/status - Get server status
 */
function handleDebugStatus(ctx: DebugApiContext): Response {
  const users = getAllUsers(ctx.sql, ctx.schemaRegistry)
  const schemas = ctx.schemaRegistry.all()
  const connections: Array<{ userId: string; role: string; subscriptions: number }> = []
  
  for (const ws of ctx.state.getWebSockets()) {
    const attachment = ws.deserializeAttachment() as ConnectionAttachment | null
    if (attachment) {
      connections.push({
        userId: attachment.userId,
        role: attachment.role,
        subscriptions: attachment.subscriptions.length,
      })
    }
  }

  return Response.json(
    { users, schemas: schemas.map(s => s.name), connections },
    { headers: CORS_HEADERS }
  )
}

/**
 * GET /api/debug/records/:collection - Get records in a collection
 */
function handleDebugRecords(ctx: DebugApiContext, path: string): Response {
  const collection = path.replace('debug/records/', '')
  const schema = ctx.schemaRegistry.get(collection)
  const columns = (schema?.columns ?? []).map(resolveColumn)

  try {
    const selectSql = columns.length > 0
      ? buildTableSelect(collection, columns) + ` ORDER BY _created_at DESC`
      : `SELECT * FROM "${collectionTableName(collection)}" ORDER BY _created_at DESC`

    const cursor = ctx.sql.exec(selectSql)
    const records = cursor.toArray().map((row: unknown) => {
      const r = row as { _row_id: string; _created_by: string; _created_at: string; _updated_at: string; [key: string]: unknown }
      return {
        recordId: r._row_id,
        data: columns.length > 0 ? rowToData(r, columns) : {},
        createdBy: r._created_by,
        createdAt: r._created_at,
      }
    })
    return Response.json({ collection, records }, { headers: CORS_HEADERS })
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : 'Query failed',
      collection,
    }, { status: 400, headers: CORS_HEADERS })
  }
}

/**
 * GET /api/debug/query - Test query as a specific user
 */
function handleDebugQuery(ctx: DebugApiContext, url: URL): Response {
  const collection = url.searchParams.get('collection')
  const userId = url.searchParams.get('userId')
  const role = url.searchParams.get('role')

  if (!collection) {
    return Response.json({ error: 'collection parameter required' }, { status: 400, headers: CORS_HEADERS })
  }
  if (!userId) {
    return Response.json({ error: 'userId parameter required' }, { status: 400, headers: CORS_HEADERS })
  }
  if (!role) {
    return Response.json({ error: 'role parameter required' }, { status: 400, headers: CORS_HEADERS })
  }

  // Get user info
  const user = getUser(ctx.sql, userId, ctx.schemaRegistry)
  if (!user) {
    return Response.json({ error: `User not found: ${userId}` }, { status: 404, headers: CORS_HEADERS })
  }

  // Build query from URL params
  const query: Query = { collection }
  
  // Parse where filters from URL (e.g., where.userId=xxx)
  const where: Record<string, unknown> = {}
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('where.')) {
      const field = key.replace('where.', '')
      where[field] = value
    }
  }
  if (Object.keys(where).length > 0) {
    query.where = where
  }

  // Execute with specified role (override user's actual role for testing)
  const records = executeQuery(ctx, query, userId, role)

  return Response.json({
    query,
    asUser: { id: userId, name: user.name, actualRole: user.role, testingAsRole: role },
    recordCount: records.length,
    records,
  }, { headers: CORS_HEADERS })
}

/**
 * GET/POST /api/debug/sql - Run arbitrary SQL queries
 * 
 * GET: /api/debug/sql?q=SELECT * FROM users
 * POST: { "sql": "SELECT * FROM users", "params": [] }
 * 
 * Special queries:
 * - "SHOW TABLES" or ".tables" - list all tables
 * - "DESCRIBE <table>" or ".schema <table>" - show table schema
 */
async function handleDebugSql(
  ctx: DebugApiContext,
  request: Request,
  url: URL
): Promise<Response> {
  let sql: string
  let params: unknown[] = []

  if (request.method === 'POST') {
    const body = await request.json() as { sql: string; params?: unknown[] }
    sql = body.sql
    params = body.params ?? []
  } else {
    sql = url.searchParams.get('q') ?? ''
  }

  if (!sql.trim()) {
    return Response.json({ 
      error: 'SQL query required',
      usage: {
        get: '/api/debug/sql?q=SELECT * FROM users',
        post: '{ "sql": "SELECT * FROM users", "params": [] }',
        special: [
          'SHOW TABLES - list all tables',
          'DESCRIBE <table> - show table schema',
        ],
      },
    }, { status: 400, headers: CORS_HEADERS })
  }

  const sqlUpper = sql.trim().toUpperCase()

  try {
    // Handle special commands
    if (sqlUpper === 'SHOW TABLES' || sqlUpper === '.TABLES') {
      const cursor = ctx.sql.exec(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      )
      const tables = cursor.toArray().map((r: unknown) => (r as { name: string }).name)
      return Response.json({ tables }, { headers: CORS_HEADERS })
    }

    if (sqlUpper.startsWith('DESCRIBE ') || sqlUpper.startsWith('.SCHEMA ')) {
      const tableName = sql.trim().split(/\s+/)[1]
      const cursor = ctx.sql.exec(`PRAGMA table_info(${tableName})`)
      const columns = cursor.toArray().map((r: unknown) => {
        const col = r as { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
        return {
          name: col.name,
          type: col.type,
          notNull: col.notnull === 1,
          defaultValue: col.dflt_value,
          primaryKey: col.pk === 1,
        }
      })
      return Response.json({ table: tableName, columns }, { headers: CORS_HEADERS })
    }

    // Execute the query
    const cursor = ctx.sql.exec(sql, ...params)
    const rows = cursor.toArray()

    return Response.json({ 
      sql,
      rowCount: rows.length,
      rows,
    }, { headers: CORS_HEADERS })
  } catch (error) {
    return Response.json({ 
      error: error instanceof Error ? error.message : 'Query failed',
      sql,
    }, { status: 400, headers: CORS_HEADERS })
  }
}
