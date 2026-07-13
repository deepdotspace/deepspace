/**
 * Tools API HTTP handlers for RecordRoom
 *
 * Provides an HTTP interface for agent tool calls (records, schemas, users).
 *
 * Caller identity is supplied via HTTP headers:
 *
 *   X-User-Id:    <userId>     — identifies the caller (required for any
 *                                 tool that touches user-bound data).
 *   X-App-Action: 'true'       — bypass user RBAC because the app's
 *                                 server-side code is already the trust
 *                                 boundary. Used by server actions and
 *                                 cron jobs; unsafe to pass from clients.
 *
 * The userId is looked up in the users collection to derive the caller's
 * role. All operations go through the same RBAC checks as the WebSocket
 * path unless flagged as an app action.
 */

import * as Y from 'yjs'
import type { ToolResult } from '../utils/tools'
import { BUILT_IN_TOOLS } from '../utils/tools'
import type { YjsDocKey } from '../../shared/types'
import { executeQuery, type SubscriptionContext } from './subscriptions'
import { getRecord, putRecord, deleteRecord, readRecord, type RecordContext } from './records'
import { getUser, getAllUsers, registerUser } from './users'
import { getOrCreateYjsDoc, broadcastYjsUpdate, getYjsDocKey, SYSTEM_COLLECTIONS, type YjsContext } from './yjs'
import { canRead, canUpdate } from '../schemas/registry'

export interface ToolsApiContext extends SubscriptionContext {
  state: DurableObjectState
  yjsDocs: Map<YjsDocKey, Y.Doc>
  sendBinary: (ws: WebSocket, data: Uint8Array) => void
  ownerUserId?: string
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-User-Id, X-App-Action',
  'Content-Type': 'application/json',
}

/**
 * Handle /tools/ API requests.
 * Called from handleApiRequest when path starts with 'tools/'.
 */
export async function handleToolsRequest(
  ctx: ToolsApiContext,
  request: Request,
  path: string
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  // GET /tools/list — return all tool schemas
  if (path === 'tools/list') {
    return Response.json({ tools: BUILT_IN_TOOLS }, { headers: CORS_HEADERS })
  }

  // GET /tools/describe/:toolName — return single tool schema
  if (path.startsWith('tools/describe/')) {
    const toolName = path.replace('tools/describe/', '')
    const tool = BUILT_IN_TOOLS.find(t => t.name === toolName)
    if (!tool) {
      return Response.json({ error: `Tool not found: ${toolName}` }, { status: 404, headers: CORS_HEADERS })
    }
    return Response.json({ tool }, { headers: CORS_HEADERS })
  }

  // POST /tools/execute — execute a tool
  // Path may include a trailing roomId (e.g., tools/execute/{roomId}) from the call script,
  // but the DO doesn't need it since the outer worker already routed to the correct DO.
  if (path.startsWith('tools/execute') && request.method === 'POST') {
    return handleToolExecute(ctx, request)
  }

  return Response.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS })
}

/**
 * POST /tools/execute
 *
 * Body:    { tool: string, params: Record<string, unknown> }
 * Headers: X-User-Id (required for identity-bound tools)
 *          X-App-Action: 'true' (optional, bypasses user RBAC)
 */
async function handleToolExecute(
  ctx: ToolsApiContext,
  request: Request
): Promise<Response> {
  let body: { tool: string; params: Record<string, unknown> }
  try {
    body = await request.json() as typeof body
  } catch {
    return Response.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400, headers: CORS_HEADERS }
    )
  }

  const { tool, params = {} } = body

  if (!tool) {
    return Response.json(
      { success: false, error: 'Missing "tool" in request body' },
      { status: 400, headers: CORS_HEADERS }
    )
  }

  // Caller identity is an HTTP header. Missing header ⇒ anonymous viewer.
  const userId = request.headers.get('x-user-id') ?? ''
  const isAppAction = request.headers.get('x-app-action')?.toLowerCase() === 'true'

  // Look up user role for RBAC. If the caller is the deploy-time owner, grant
  // admin — mirrors the WebSocket path which registers the owner explicitly.
  // The HTTP tools API doesn't go through WebSocket, so the owner may not
  // exist in the users table yet.
  let userRole = 'viewer'
  if (userId && ctx.ownerUserId && userId === ctx.ownerUserId) {
    userRole = 'admin'
  } else if (userId) {
    const user = getUser(ctx.sql, userId, ctx.schemaRegistry)
    if (user) {
      userRole = user.role
    }
  }

  // Yjs tools need async execution — handle before sync dispatch
  if (tool.startsWith('yjs.')) {
    const result = await executeYjsTool(ctx, tool, params, userId, userRole)
    const status = result.success ? 200 : (result.error?.includes('not found') ? 404 : 400)
    return Response.json(result, { status, headers: CORS_HEADERS })
  }

  const recordCtx: RecordContext = {
    sql: ctx.sql,
    schemaRegistry: ctx.schemaRegistry,
    state: ctx.state,
    getPermissionContext: ctx.getPermissionContext,
    send: ctx.send,
  }

  const result = await executeTool(recordCtx, tool, params, userId, userRole, isAppAction)
  const status = result.success ? 200 : (result.error?.includes('not found') ? 404 : 400)
  return Response.json(result, { status, headers: CORS_HEADERS })
}

/**
 * Dispatch a tool call to the appropriate handler.
 */
async function executeTool(
  ctx: RecordContext,
  toolName: string,
  params: Record<string, unknown>,
  userId: string,
  userRole: string,
  skipUserRbac: boolean,
): Promise<ToolResult> {
  switch (toolName) {
    // ---- Records ----
    case 'records.query': {
      const collection = params.collection as string
      if (!collection) return { success: false, error: 'Missing required param: collection' }
      // No default `limit` here: this dispatch is the SDK's general record-read
      // path (chat history, cron, app `actions.query`), which must return every
      // row. The assistant's page-size default is applied upstream in the AI
      // tool layer (`applyAiToolDefaults` in `buildTools`).
      const query = {
        collection,
        where: params.where as Record<string, unknown> | undefined,
        orderBy: params.orderBy as string | undefined,
        orderDir: params.orderDir as 'asc' | 'desc' | undefined,
        limit: params.limit as number | undefined,
      }
      const records = executeQuery(ctx, query, userId, userRole, skipUserRbac)
      return { success: true, data: { records, count: records.length } }
    }

    case 'records.get': {
      const collection = params.collection as string
      const recordId = params.recordId as string
      if (!collection) return { success: false, error: 'Missing required param: collection' }
      if (!recordId) return { success: false, error: 'Missing required param: recordId' }
      return readRecord(ctx, collection, recordId, userId, userRole, skipUserRbac)
    }

    case 'records.create': {
      const collection = params.collection as string
      const data = params.data as Record<string, unknown>
      if (!collection) return { success: false, error: 'Missing required param: collection' }
      if (!data) return { success: false, error: 'Missing required param: data' }
      const recordId = (params.recordId as string) || generateId()
      return putRecord(ctx, collection, recordId, data, userId, userRole, skipUserRbac)
    }

    case 'records.update': {
      const collection = params.collection as string
      const recordId = params.recordId as string
      const data = params.data as Record<string, unknown>
      if (!collection) return { success: false, error: 'Missing required param: collection' }
      if (!recordId) return { success: false, error: 'Missing required param: recordId' }
      if (!data) return { success: false, error: 'Missing required param: data' }
      return putRecord(ctx, collection, recordId, data, userId, userRole, skipUserRbac)
    }

    case 'records.delete': {
      const collection = params.collection as string
      const recordId = params.recordId as string
      if (!collection) return { success: false, error: 'Missing required param: collection' }
      if (!recordId) return { success: false, error: 'Missing required param: recordId' }
      return deleteRecord(ctx, collection, recordId, userId, userRole, skipUserRbac)
    }

    // ---- Users ----
    // Bootstrap or refresh the `users` row for a given userId. Same path
    // the SDK uses on WS connect via registerUser, exposed for server
    // contexts (CLI-only callers, action handlers) where there's no WS
    // connection to trigger the natural registration. System-managed
    // columns (email, name, imageUrl, role) are written through
    // registerUser's privileged path, bypassing the SYSTEM_MANAGED
    // stripping that blocks naive tools.create / tools.update.
    case 'users.register': {
      const targetUserId = (params.userId as string) || userId
      if (!targetUserId) return { success: false, error: 'Missing userId' }
      const name = typeof params.name === 'string' ? params.name : ''
      const email = typeof params.email === 'string' ? params.email : ''
      const imageUrl = typeof params.imageUrl === 'string' ? params.imageUrl : undefined
      const isAdmin = params.isAdmin === true
      const user = await registerUser(
        ctx.sql,
        targetUserId,
        name,
        email,
        imageUrl,
        isAdmin,
        'member',
        ctx.schemaRegistry,
      )
      return { success: true, data: { user } }
    }

    // ---- Schema ----
    case 'schema.list': {
      const schemas = ctx.schemaRegistry.all()
      return {
        success: true,
        data: {
          schemas: schemas.map(s => ({
            name: s.name,
            columns: s.columns,
            permissions: s.permissions,
            ...(s.ownerField ? { ownerField: s.ownerField } : {}),
            ...(s.collaboratorsField ? { collaboratorsField: s.collaboratorsField } : {}),
            ...(s.teamField ? { teamField: s.teamField } : {}),
          })),
        },
      }
    }

    case 'schema.describe': {
      const collection = params.collection as string
      if (!collection) return { success: false, error: 'Missing required param: collection' }
      const schema = ctx.schemaRegistry.get(collection)
      if (!schema) return { success: false, error: `Schema not found: ${collection}` }
      return { success: true, data: { schema } }
    }

    // ---- Users ----
    case 'user.current': {
      if (!userId) return { success: false, error: 'No userId provided' }
      const user = getUser(ctx.sql, userId, ctx.schemaRegistry)
      if (!user) return { success: false, error: 'User not found' }
      return { success: true, data: { user } }
    }

    case 'user.list': {
      const users = getAllUsers(ctx.sql, ctx.schemaRegistry)
      return { success: true, data: { users } }
    }

    default:
      return { success: false, error: `Unknown tool: ${toolName}` }
  }
}

// ============================================================================
// Yjs Tool Execution
// ============================================================================

/**
 * Check RBAC permission for Yjs doc access.
 * System collections are permissive (same as handleYjsJoin).
 * Returns null if permitted, or an error ToolResult if denied.
 */
function checkYjsPermission(
  ctx: ToolsApiContext,
  collection: string,
  recordId: string,
  userId: string,
  userRole: string,
  action: 'read' | 'write'
): ToolResult | null {
  if (SYSTEM_COLLECTIONS.has(collection)) return null

  const schema = ctx.schemaRegistry.get(collection)
  if (!schema) return { success: false, error: `Schema not registered for collection: ${collection}` }

  const record = getRecord(ctx.sql, collection, recordId, schema)
  if (!record) return { success: false, error: `Record not found: ${collection}/${recordId}` }

  const recordWithId = { ...record, recordId }
  const permCtx = ctx.getPermissionContext()
  if (action === 'read' && !canRead(schema, userRole, recordWithId, userId, permCtx)) {
    return { success: false, error: 'Permission denied: cannot read this record' }
  }
  if (action === 'write' && !canUpdate(schema, userRole, recordWithId, userId, permCtx)) {
    return { success: false, error: 'Permission denied: cannot update this record' }
  }

  return null
}

/**
 * Build a YjsContext from ToolsApiContext for calling Yjs helpers.
 */
function buildYjsCtx(ctx: ToolsApiContext): YjsContext {
  return {
    sql: ctx.sql,
    state: ctx.state,
    yjsDocs: ctx.yjsDocs,
    schemaRegistry: ctx.schemaRegistry,
    getPermissionContext: ctx.getPermissionContext,
    send: ctx.send,
    sendBinary: ctx.sendBinary,
  }
}

/**
 * Execute a Yjs tool (yjs.list, yjs.getText, yjs.setText).
 */
async function executeYjsTool(
  ctx: ToolsApiContext,
  toolName: string,
  params: Record<string, unknown>,
  userId: string,
  userRole: string
): Promise<ToolResult> {
  switch (toolName) {
    case 'yjs.list': {
      const rows = ctx.sql.exec(
        `SELECT doc_key, updated_at FROM yjs_docs ORDER BY updated_at DESC`
      ).toArray() as Array<{ doc_key: string; updated_at: string }>

      const docs = rows.map(row => {
        const firstColon = row.doc_key.indexOf(':')
        const lastColon = row.doc_key.lastIndexOf(':')
        return {
          docKey: row.doc_key,
          collection: row.doc_key.slice(0, firstColon),
          recordId: row.doc_key.slice(firstColon + 1, lastColon),
          fieldName: row.doc_key.slice(lastColon + 1),
          updatedAt: row.updated_at,
        }
      })
      return { success: true, data: { docs, count: docs.length } }
    }

    case 'yjs.getText': {
      const { collection, recordId, fieldName } = params as { collection: string; recordId: string; fieldName: string }
      if (!collection || !recordId || !fieldName) {
        return { success: false, error: 'Missing required params: collection, recordId, fieldName' }
      }

      const permError = checkYjsPermission(ctx, collection, recordId, userId, userRole, 'read')
      if (permError) return permError

      const docKey = getYjsDocKey(collection, recordId, fieldName)
      const yjsCtx = buildYjsCtx(ctx)
      const doc = await getOrCreateYjsDoc(yjsCtx, docKey)

      const ytext = doc.getText(fieldName)
      const text = ytext.toString()

      const sharedTypes: Record<string, string> = {}
      for (const [key, type] of doc.share) {
        if (type instanceof Y.Text) {
          sharedTypes[key || '(default)'] = `Y.Text (${type.length} chars)`
        } else if (type instanceof Y.Map) {
          sharedTypes[key] = `Y.Map (${(type as Y.Map<unknown>).size} entries)`
        } else if (type instanceof Y.Array) {
          sharedTypes[key] = `Y.Array (${(type as Y.Array<unknown>).length} items)`
        }
      }

      return { success: true, data: { docKey, text, sharedTypes } }
    }

    case 'yjs.setText': {
      const { collection, recordId, fieldName, text } = params as { collection: string; recordId: string; fieldName: string; text: string }
      if (!collection || !recordId || !fieldName) {
        return { success: false, error: 'Missing required params: collection, recordId, fieldName' }
      }
      if (text === undefined || text === null) {
        return { success: false, error: 'Missing required param: text' }
      }

      const permError = checkYjsPermission(ctx, collection, recordId, userId, userRole, 'write')
      if (permError) return permError

      const docKey = getYjsDocKey(collection, recordId, fieldName)
      const yjsCtx = buildYjsCtx(ctx)
      const doc = await getOrCreateYjsDoc(yjsCtx, docKey)

      const ytext = doc.getText(fieldName)

      let capturedUpdate: Uint8Array | null = null
      const updateHandler = (update: Uint8Array) => { capturedUpdate = update }
      doc.on('update', updateHandler)

      doc.transact(() => {
        ytext.delete(0, ytext.length)
        ytext.insert(0, text)
      })

      doc.off('update', updateHandler)

      if (capturedUpdate) {
        broadcastYjsUpdate(yjsCtx, docKey, capturedUpdate, null)
      }

      return { success: true, data: { docKey, length: text.length } }
    }

    default:
      return { success: false, error: `Unknown Yjs tool: ${toolName}` }
  }
}

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
