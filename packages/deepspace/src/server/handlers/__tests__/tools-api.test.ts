/**
 * Tests for built-in tool dispatch, paging, result caps, and Yjs cache lifetime.
 *
 * Two related guarantees, locked down end to end:
 *
 *   1. The shared `records.query` dispatch (`handleToolsRequest`) stays
 *      unbounded when the caller omits `limit`. The assistant's page-size
 *      default is applied upstream in the AI tool layer
 *      (`applyAiToolDefaults`), so internal record readers (chat history,
 *      cron, app `actions.query`) that hit this dispatch directly are not
 *      silently capped.
 *
 *   2. A page that is oversized degrades *gracefully* via `capToolResultSize`:
 *      the caller gets a usable `success: true` prefix with
 *      `{ truncated, returned, total }` flags, not a hard failure that drops
 *      every record.
 *
 * The cap is applied by the chat route that wraps each tool result before the
 * model sees it; these tests call `capToolResultSize` directly to exercise
 * that step against the real `executeQuery` output.
 *
 * Setup mirrors `subscriptions.test.ts`: an in-memory better-sqlite3 instance
 * fronted by a small `SqlStorage` shim, a registered schema materialised via
 * `ensureCollectionTable`, and hand-inserted fixtures.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type { ConnectionAttachment } from '../../../shared/protocol/types'
import type { YjsSubscription } from '../../../shared/types'
import { executeQuery } from '../subscriptions'
import { handleToolsRequest, type ToolsApiContext } from '../tools-api'
import {
  getOrCreateYjsDoc,
  getYjsDocKey,
  handleYjsDisconnect,
  handleYjsLeave,
  type YjsContext,
} from '../yjs'
import {
  SchemaRegistry,
  noopPermissionContext,
  columnId,
  type CollectionSchema,
} from '../../schemas/registry'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import { capToolResultSize, DEFAULT_CONTEXT_CONFIG } from '../../utils/chat-context'

const CAP = DEFAULT_CONTEXT_CONFIG.toolResultCap

// ---------------------------------------------------------------------------
// Test infra (SqlStorage shim over better-sqlite3)
// ---------------------------------------------------------------------------

function makeSql(db: Database.Database): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]): { toArray: () => unknown[] } {
      const trimmed = query.trim()
      const isSelect = /^(SELECT|PRAGMA)/i.test(trimmed)
      if (bindings.length === 0 && !isSelect) {
        db.exec(query)
        return { toArray: () => [] }
      }
      const stmt = db.prepare(query)
      if (isSelect) {
        return { toArray: () => stmt.all(...bindings) }
      }
      stmt.run(...bindings)
      return { toArray: () => [] }
    },
    get databaseSize(): number { return 0 },
    Cursor: undefined as unknown as SqlStorage['Cursor'],
    Statement: undefined as unknown as SqlStorage['Statement'],
  } as unknown as SqlStorage
}

function makeToolsContext(
  sql: SqlStorage,
  schemas: CollectionSchema[],
  state: DurableObjectState = {
    getWebSockets: () => [],
  } as unknown as DurableObjectState,
): ToolsApiContext {
  return {
    sql,
    schemaRegistry: new SchemaRegistry(schemas),
    state,
    getPermissionContext: () => noopPermissionContext,
    send: () => {},
    yjsDocs: new Map(),
    sendBinary: () => {},
  }
}

function makeSocket(attachment: ConnectionAttachment): WebSocket {
  return {
    deserializeAttachment: () => attachment,
    serializeAttachment: () => {},
  } as unknown as WebSocket
}

function makeYjsContext(sql: SqlStorage, state: DurableObjectState): YjsContext {
  return {
    sql,
    state,
    yjsDocs: new Map(),
    schemaRegistry: new SchemaRegistry([]),
    getPermissionContext: () => noopPermissionContext,
    send: () => {},
    sendBinary: () => {},
  }
}

function createYjsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE yjs_docs (
      doc_key TEXT PRIMARY KEY,
      state BLOB NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
}

function yjsAttachment(subscription: YjsSubscription): ConnectionAttachment {
  return {
    userId: crypto.randomUUID(),
    userName: 'Test User',
    userEmail: 'test@example.com',
    role: 'member',
    subscriptions: [],
    yjsSubscriptions: [subscription],
  }
}

/** Insert a row into a c_* table by hand (cols keyed by schema column name). */
function insert(
  db: Database.Database,
  tableName: string,
  row: { recordId: string; createdBy: string; cols?: Record<string, unknown> },
) {
  const ts = '2026-05-06T00:00:00.000Z'
  const cols = row.cols ?? {}
  const names = Object.keys(cols)
  const colCols = names.map(c => `"${columnId(c)}"`).join(',')
  const colVals = names.map(() => '?').join(',')
  const sql =
    `INSERT INTO ${tableName} ` +
    `(_row_id, _created_by, _created_at, _updated_at${names.length ? ',' + colCols : ''}) ` +
    `VALUES (?, ?, ?, ?${names.length ? ',' + colVals : ''})`
  db.prepare(sql).run(row.recordId, row.createdBy, ts, ts, ...Object.values(cols))
}

/** Execute a tool via the public HTTP entry point, returning the parsed body. */
async function execTool(
  ctx: ToolsApiContext,
  tool: string,
  params: Record<string, unknown>,
): Promise<{ success: boolean; data: { records: unknown[]; count?: number; [k: string]: unknown }; [k: string]: unknown }> {
  const request = new Request('https://internal/api/tools/execute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Bypass per-user RBAC — these tests are about paging/capping, not auth
      // (auth is covered in subscriptions.test.ts).
      'X-App-Action': 'true',
    },
    body: JSON.stringify({ tool, params }),
  })
  const res = await handleToolsRequest(ctx, request, 'tools/execute')
  return res.json() as Promise<Awaited<ReturnType<typeof execTool>>>
}

// ---------------------------------------------------------------------------
// Fixtures: a `companies` collection big enough to exceed the byte cap.
// ---------------------------------------------------------------------------

const companies: CollectionSchema = {
  name: 'companies',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain' },
    { name: 'blob', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    member: { read: true, create: true, update: true, delete: true },
  },
}

/** Roughly bytes-per-record once serialized — sized so N rows overflow CAP. */
function seed(db: Database.Database, count: number, blobLen: number) {
  for (let i = 0; i < count; i++) {
    insert(db, 'c_companies', {
      recordId: `co${i}`,
      createdBy: 'admin',
      cols: { name: `Company ${i}`, blob: 'x'.repeat(blobLen) },
    })
  }
}

describe('records.query limit (shared dispatch stays unbounded)', () => {
  let db: Database.Database
  let ctx: ToolsApiContext

  beforeEach(() => {
    db = new Database(':memory:')
    const sql = makeSql(db)
    ctx = makeToolsContext(sql, [companies])
    ensureCollectionTable(sql, companies)
    seed(db, 80, 20) // 80 small rows — well under the cap
  })

  it('returns every row when `limit` is omitted (the assistant page-size default lives in the AI tool layer, not here)', async () => {
    // Internal record readers (chat history, cron, app `actions.query`) reach
    // this dispatch directly and must not be silently capped. The 50-row
    // assistant default lives in `applyAiToolDefaults` (buildTools), upstream.
    const out = await execTool(ctx, 'records.query', { collection: 'companies' })
    expect(out.success).toBe(true)
    expect(out.data.records).toHaveLength(80)
    expect(out.data.count).toBe(80)
  })

  it('honors an explicit smaller `limit`', async () => {
    const out = await execTool(ctx, 'records.query', { collection: 'companies', limit: 5 })
    expect(out.success).toBe(true)
    expect(out.data.records).toHaveLength(5)
  })

  it('honors an explicit larger `limit` (up to what exists)', async () => {
    const out = await execTool(ctx, 'records.query', { collection: 'companies', limit: 1000 })
    expect(out.success).toBe(true)
    expect(out.data.records).toHaveLength(80)
  })
})

describe('records.query oversized result degrades to a usable page', () => {
  let db: Database.Database
  let ctx: ToolsApiContext

  beforeEach(() => {
    db = new Database(':memory:')
    const sql = makeSql(db)
    ctx = makeToolsContext(sql, [companies])
    ensureCollectionTable(sql, companies)
    // ~700 bytes/row × 120 rows ≈ 84KB — comfortably over the 30KB cap even
    // after the default 50-row page.
    seed(db, 120, 700)
  })

  it('raw query path: executeQuery → capToolResultSize yields a partial page, not a failure', () => {
    const records = executeQuery(ctx, { collection: 'companies' }, '', 'member', true)
    expect(records.length).toBe(120) // raw path is unbounded — no default limit here
    const raw = { success: true, data: { records, count: records.length } }
    expect(JSON.stringify(raw).length).toBeGreaterThan(CAP) // precondition: actually oversized

    const out = capToolResultSize(raw, CAP) as { success: boolean; data: Record<string, unknown> }
    expect(out.success).toBe(true)
    expect(out.data.truncated).toBe(true)
    expect(out.data.total).toBe(120)
    expect((out.data.records as unknown[]).length).toBe(out.data.returned)
    expect((out.data.returned as number)).toBeGreaterThan(0)
    expect((out.data.returned as number)).toBeLessThan(120)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(CAP)
  })

  it('AI tool executor path: an explicit large limit still degrades gracefully under the cap', async () => {
    const result = await execTool(ctx, 'records.query', { collection: 'companies', limit: 120 })
    expect(result.success).toBe(true)
    expect(result.data.records).toHaveLength(120)
    expect(JSON.stringify(result).length).toBeGreaterThan(CAP) // precondition

    // chat-routes wraps every tool result in capToolResultSize before handing
    // it to the model — replicate that step here.
    const capped = capToolResultSize(result, CAP) as { success: boolean; data: Record<string, unknown> }
    expect(capped.success).toBe(true)
    expect(capped.data.truncated).toBe(true)
    expect(capped.data.total).toBe(120)
    expect((capped.data.records as unknown[]).length).toBe(capped.data.returned)
    expect((capped.data.returned as number)).toBeGreaterThan(0)
    expect((capped.data.returned as number)).toBeLessThan(120)
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(CAP)
  })
})

describe('built-in tool catalog', () => {
  it('advertises only tools owned by the main or Yjs dispatcher', async () => {
    const db = new Database(':memory:')
    const sql = makeSql(db)
    const ctx = makeToolsContext(sql, [companies])

    // The two parameter-free list tools reach storage. Empty tables let the
    // parity check exercise their real dispatcher cases without extra fixtures.
    db.exec(`
      CREATE TABLE c_users (
        _row_id TEXT PRIMARY KEY,
        _created_by TEXT NOT NULL,
        _created_at TEXT NOT NULL,
        _updated_at TEXT NOT NULL
      );
      CREATE TABLE yjs_docs (
        doc_key TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL
      );
    `)

    const listResponse = await handleToolsRequest(
      ctx,
      new Request('https://internal/api/tools/list'),
      'tools/list',
    )
    const { tools } = await listResponse.json() as { tools: Array<{ name: string }> }
    const toolNames = tools.map(tool => tool.name)

    expect(new Set(toolNames).size).toBe(toolNames.length)
    expect(toolNames.filter(name => name.startsWith('yjs.'))).toEqual([
      'yjs.list',
      'yjs.getText',
      'yjs.setText',
    ])

    for (const toolName of toolNames) {
      const executeResponse = await handleToolsRequest(
        ctx,
        new Request('https://internal/api/tools/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: toolName, params: {} }),
        }),
        'tools/execute',
      )
      const result = await executeResponse.json() as { success: boolean; error?: string }
      const unknownError = toolName.startsWith('yjs.')
        ? `Unknown Yjs tool: ${toolName}`
        : `Unknown tool: ${toolName}`

      expect(result, `${toolName} has no dispatcher case`).not.toEqual(
        expect.objectContaining({ success: false, error: unknownError }),
      )
    }
  })
})

describe('Yjs document cache lifetime', () => {
  it('keeps a subscribed document and evicts it when the final subscriber leaves', () => {
    const db = new Database(':memory:')
    createYjsTable(db)
    const sql = makeSql(db)
    const subscription = { collection: 'docs', recordId: 'doc-1', fieldName: 'body' }
    const firstAttachment = yjsAttachment(subscription)
    const secondAttachment = yjsAttachment(subscription)
    const firstSocket = makeSocket(firstAttachment)
    const secondSocket = makeSocket(secondAttachment)
    const state = {
      getWebSockets: () => [firstSocket, secondSocket],
    } as unknown as DurableObjectState
    const ctx = makeYjsContext(sql, state)
    const docKey = getYjsDocKey('docs', 'doc-1', 'body')
    const doc = getOrCreateYjsDoc(ctx, docKey)
    doc.getText('body').insert(0, 'persisted')

    handleYjsLeave(ctx, firstSocket, firstAttachment, subscription)
    expect(ctx.yjsDocs.get(docKey)).toBe(doc)
    expect(doc.isDestroyed).toBe(false)

    handleYjsLeave(ctx, secondSocket, secondAttachment, subscription)
    expect(ctx.yjsDocs.has(docKey)).toBe(false)
    expect(doc.isDestroyed).toBe(true)

    const reloaded = getOrCreateYjsDoc(ctx, docKey)
    expect(reloaded).not.toBe(doc)
    expect(reloaded.getText('body').toString()).toBe('persisted')
    db.close()
  })

  it('evicts documents held only by a closed connection', () => {
    const db = new Database(':memory:')
    createYjsTable(db)
    const sql = makeSql(db)
    const subscription = { collection: 'docs', recordId: 'doc-1', fieldName: 'body' }
    const attachment = yjsAttachment(subscription)
    const socket = makeSocket(attachment)
    const state = {
      getWebSockets: () => [socket],
    } as unknown as DurableObjectState
    const ctx = makeYjsContext(sql, state)
    const docKey = getYjsDocKey('docs', 'doc-1', 'body')
    const doc = getOrCreateYjsDoc(ctx, docKey)

    handleYjsDisconnect(ctx, socket, attachment)

    expect(ctx.yjsDocs.has(docKey)).toBe(false)
    expect(doc.isDestroyed).toBe(true)
    db.close()
  })

  it('does not retain documents loaded only for a tool call', async () => {
    const db = new Database(':memory:')
    createYjsTable(db)
    const sql = makeSql(db)
    const ctx = makeToolsContext(sql, [])

    const write = await execTool(ctx, 'yjs.setText', {
      collection: 'canvas-settings',
      recordId: 'canvas-1',
      fieldName: 'body',
      text: 'persisted',
    })
    expect(write.success).toBe(true)
    expect(ctx.yjsDocs.size).toBe(0)

    const read = await execTool(ctx, 'yjs.getText', {
      collection: 'canvas-settings',
      recordId: 'canvas-1',
      fieldName: 'body',
    })
    expect(read).toMatchObject({ success: true, data: { text: 'persisted' } })
    expect(ctx.yjsDocs.size).toBe(0)
    db.close()
  })
})
