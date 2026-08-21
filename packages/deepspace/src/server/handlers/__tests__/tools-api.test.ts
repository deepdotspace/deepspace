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
import { deleteWhere } from '../records'
import { handleToolsRequest, type ToolsApiContext } from '../tools-api'
import { DEFAULT_DELETE_WHERE_LIMIT, MAX_DELETE_WHERE_LIMIT } from '../../utils/tools'
import {
  getOrCreateYjsDoc,
  getYjsDocKey,
  handleYjsDisconnect,
  handleYjsLeave,
  type YjsContext,
} from '../yjs'
import {
  BASE_USERS_SCHEMA,
  SchemaRegistry,
  noopPermissionContext,
  columnId,
  type CollectionSchema,
} from '../../schemas/registry'
import { registerUser } from '../users'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import { capToolResultSize, DEFAULT_CONTEXT_CONFIG } from '../../utils/chat-context'
import { MSG_YJS_AWARENESS } from '../../../shared/protocol/constants'
import { createDecoder, readVarUint, readVarUint8Array } from '../../../shared/protocol/yjs'

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
    get databaseSize(): number {
      return 0
    },
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
  const colCols = names.map((c) => `"${columnId(c)}"`).join(',')
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
): Promise<{
  success: boolean
  data: { records: unknown[]; count?: number; [k: string]: unknown }
  [k: string]: unknown
}> {
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
    expect(out.data.returned as number).toBeGreaterThan(0)
    expect(out.data.returned as number).toBeLessThan(120)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(CAP)
  })

  it('AI tool executor path: an explicit large limit still degrades gracefully under the cap', async () => {
    const result = await execTool(ctx, 'records.query', { collection: 'companies', limit: 120 })
    expect(result.success).toBe(true)
    expect(result.data.records).toHaveLength(120)
    expect(JSON.stringify(result).length).toBeGreaterThan(CAP) // precondition

    // chat-routes wraps every tool result in capToolResultSize before handing
    // it to the model — replicate that step here.
    const capped = capToolResultSize(result, CAP) as {
      success: boolean
      data: Record<string, unknown>
    }
    expect(capped.success).toBe(true)
    expect(capped.data.truncated).toBe(true)
    expect(capped.data.total).toBe(120)
    expect((capped.data.records as unknown[]).length).toBe(capped.data.returned)
    expect(capped.data.returned as number).toBeGreaterThan(0)
    expect(capped.data.returned as number).toBeLessThan(120)
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(CAP)
  })
})

// ---------------------------------------------------------------------------
// records.deleteWhere — the bounded batch delete behind cascading deletes.
// ---------------------------------------------------------------------------

const notes: CollectionSchema = {
  name: 'notes',
  columns: [
    { name: 'chatId', storage: 'text', interpretation: 'plain' },
    { name: 'body', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    member: { read: true, create: true, update: true, delete: true },
    viewer: { read: true, create: false, update: false, delete: false },
  },
}

function seedNotes(db: Database.Database, chatId: string, count: number, from = 0) {
  for (let i = from; i < from + count; i++) {
    insert(db, 'c_notes', {
      recordId: `${chatId}-n${i}`,
      createdBy: 'author',
      cols: { chatId, body: `note ${i}` },
    })
  }
}

function noteCount(db: Database.Database, chatId?: string): number {
  const sql = chatId
    ? `SELECT COUNT(*) AS n FROM c_notes WHERE "${columnId('chatId')}" = ?`
    : `SELECT COUNT(*) AS n FROM c_notes`
  const row = (chatId ? db.prepare(sql).get(chatId) : db.prepare(sql).get()) as { n: number }
  return row.n
}

describe('records.deleteWhere', () => {
  let db: Database.Database
  let ctx: ToolsApiContext

  beforeEach(() => {
    db = new Database(':memory:')
    const sql = makeSql(db)
    ctx = makeToolsContext(sql, [notes])
    ensureCollectionTable(sql, notes)
  })

  it('deletes only the matching rows and reports how many', async () => {
    seedNotes(db, 'chat-1', 5)
    seedNotes(db, 'chat-2', 3)

    const out = await execTool(ctx, 'records.deleteWhere', {
      collection: 'notes',
      where: { chatId: 'chat-1' },
    })

    expect(out).toMatchObject({ success: true, data: { deleted: 5 } })
    expect(noteCount(db, 'chat-1')).toBe(0)
    expect(noteCount(db, 'chat-2')).toBe(3)
  })

  it('caps a call at `limit` so the caller can drain a large set page by page', async () => {
    seedNotes(db, 'chat-1', 25)

    const first = await execTool(ctx, 'records.deleteWhere', {
      collection: 'notes',
      where: { chatId: 'chat-1' },
      limit: 10,
    })
    expect(first.data.deleted).toBe(10)
    expect(noteCount(db, 'chat-1')).toBe(15)

    // Paging terminates: every full page really removes its rows, and a short
    // page is the last one — the contract `deleteChatCascade` loops on.
    let deleted = 10
    while (deleted === 10) {
      const page = await execTool(ctx, 'records.deleteWhere', {
        collection: 'notes',
        where: { chatId: 'chat-1' },
        limit: 10,
      })
      deleted = page.data.deleted as number
    }
    expect(deleted).toBe(5)
    expect(noteCount(db, 'chat-1')).toBe(0)
  })

  it('clamps an oversized limit to the ceiling instead of running unbounded', async () => {
    seedNotes(db, 'chat-1', MAX_DELETE_WHERE_LIMIT + 20)

    const out = await execTool(ctx, 'records.deleteWhere', {
      collection: 'notes',
      where: { chatId: 'chat-1' },
      limit: 100_000,
    })

    expect(out.data.deleted).toBe(MAX_DELETE_WHERE_LIMIT)
    expect(noteCount(db, 'chat-1')).toBe(20)
  })

  it('defaults to the standard page size when no limit is given', async () => {
    seedNotes(db, 'chat-1', DEFAULT_DELETE_WHERE_LIMIT + 5)

    const out = await execTool(ctx, 'records.deleteWhere', {
      collection: 'notes',
      where: { chatId: 'chat-1' },
    })

    expect(out.data.deleted).toBe(DEFAULT_DELETE_WHERE_LIMIT)
  })

  it('refuses a missing or empty filter — it never truncates a collection', async () => {
    seedNotes(db, 'chat-1', 3)

    for (const params of [{ collection: 'notes' }, { collection: 'notes', where: {} }]) {
      const out = await execTool(ctx, 'records.deleteWhere', params)
      expect(out.success).toBe(false)
      expect(out.error).toContain('where')
    }
    expect(noteCount(db)).toBe(3)
  })

  it('records.query refuses an unknown where key too — a dropped filter over-returns', async () => {
    seedNotes(db, 'chat-1', 3)
    seedNotes(db, 'chat-2', 2)

    const typo = await execTool(ctx, 'records.query', {
      collection: 'notes',
      where: { chatid_typo: 'chat-1' },
    })
    expect(typo.success).toBe(false)
    expect(typo.error).toContain('chatid_typo')
    expect(typo.error).toContain('recordId, createdBy, chatId, body')

    // The real key still filters, and no where still returns everything.
    const real = await execTool(ctx, 'records.query', {
      collection: 'notes',
      where: { chatId: 'chat-1' },
    })
    expect(real.data.count).toBe(3)
    const all = await execTool(ctx, 'records.query', { collection: 'notes' })
    expect(all.data.count).toBe(5)
  })

  it('names an array or scalar `where` for what it is instead of reporting a field "0"', async () => {
    // `refuseUnknownWhere` owns the shape check for both tools now: `[]` used
    // to slip through the query path's emptiness test and filter nothing, and
    // `['chatId']` was reported as an unknown field named "0".
    seedNotes(db, 'chat-1', 3)

    for (const where of [[], ['chatId'], 'chatId', 7]) {
      for (const tool of ['records.query', 'records.deleteWhere']) {
        const out = await execTool(ctx, tool, { collection: 'notes', where })
        expect(out.success, `${tool} with ${JSON.stringify(where)}`).toBe(false)
        expect(out.error).toContain('must be an object of field=value pairs')
        expect(out.error).toContain('recordId, createdBy, chatId, body')
      }
    }
    expect(noteCount(db)).toBe(3)
  })

  it('refuses ANY `where` on a schemaless system collection', async () => {
    // `executeSystemQuery` ignores `where` entirely, so a filter on a
    // schemaless collection — even by `recordId` — would hand back the whole
    // collection as if filtered. The one guard refuses every non-empty
    // `where` there and says why.
    db.exec(
      `CREATE TABLE c_canvas_settings (_row_id TEXT PRIMARY KEY, _created_by TEXT, _created_at TEXT, _updated_at TEXT)`,
    )
    insert(db, 'c_canvas_settings', { recordId: 's1', createdBy: 'someone' })

    for (const where of [{ anything: 'x' }, { recordId: 's1' }]) {
      const out = await execTool(ctx, 'records.query', { collection: 'canvas-settings', where })
      expect(out.success).toBe(false)
      expect(out.error).toBe(
        '"canvas-settings" has no schema, so it has no filterable fields — query it without `where`',
      )
    }

    // Without a `where` it is still a readable collection.
    const rows = await execTool(ctx, 'records.query', { collection: 'canvas-settings' })
    expect(rows).toMatchObject({ success: true, data: { count: 1 } })
  })

  it('refuses a filter key that names no field instead of silently dropping it', async () => {
    // executeQuery ignores unknown where keys; a delete that inherited that
    // leniency would truncate a page of the collection on a typo.
    seedNotes(db, 'chat-1', 8)

    const cases: Record<string, unknown>[] = [
      { chatId_typo: 'chat-1' },
      { chatId: 'chat-1', nosuch: 'x' },
      ['chatId', 'body'] as unknown as Record<string, unknown>,
    ]
    for (const where of cases) {
      const out = await execTool(ctx, 'records.deleteWhere', { collection: 'notes', where })
      expect(out.success).toBe(false)
    }
    const named = await execTool(ctx, 'records.deleteWhere', {
      collection: 'notes',
      where: { chatId_typo: 'chat-1' },
    })
    expect(named.error).toContain('chatId_typo')
    expect(named.error).toContain('recordId, createdBy, chatId, body')
    expect(noteCount(db)).toBe(8)
  })

  it('refuses a non-numeric limit instead of running without one', async () => {
    seedNotes(db, 'chat-1', DEFAULT_DELETE_WHERE_LIMIT + 5)

    for (const limit of ['all', {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = await execTool(ctx, 'records.deleteWhere', {
        collection: 'notes',
        where: { chatId: 'chat-1' },
        limit,
      })
      expect(out).toMatchObject({ success: false })
      expect(out.error).toContain('limit')
    }
    expect(noteCount(db, 'chat-1')).toBe(DEFAULT_DELETE_WHERE_LIMIT + 5)
  })

  it('refuses a schemaless system collection, whose query ignores where entirely', async () => {
    db.exec(
      `CREATE TABLE c_canvas_settings (_row_id TEXT PRIMARY KEY, _created_by TEXT, _created_at TEXT, _updated_at TEXT)`,
    )
    insert(db, 'c_canvas_settings', { recordId: 's1', createdBy: 'someone' })

    const out = await execTool(ctx, 'records.deleteWhere', {
      collection: 'canvas-settings',
      where: { anything: 'x' },
    })

    expect(out).toMatchObject({ success: false })
    expect(out.error).toContain('no schema')
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM c_canvas_settings').get() as { n: number }).n,
    ).toBe(1)
  })

  it('does not use read filtering to hide matched rows from delete authorization', async () => {
    // Bob's rows sort ahead of Alice's. A read filter used as candidate
    // selection would silently hide them and turn a broad delete into
    // "delete whichever matching rows I can read".
    const ownNotes: CollectionSchema = {
      ...notes,
      name: 'own_notes',
      permissions: { member: { read: 'own', create: true, update: 'own', delete: 'own' } },
    }
    const sqlite = makeSql(db)
    ctx = makeToolsContext(sqlite, [ownNotes])
    ensureCollectionTable(sqlite, ownNotes)
    for (let i = 0; i < 4; i++) {
      insert(db, 'c_own_notes', {
        recordId: `bob-${i}`,
        createdBy: 'bob',
        cols: { chatId: 'c', body: 'b' },
      })
    }
    for (let i = 0; i < 4; i++) {
      insert(db, 'c_own_notes', {
        recordId: `alice-${i}`,
        createdBy: 'alice',
        cols: { chatId: 'c', body: 'a' },
      })
    }

    const result = deleteWhere(ctx, 'own_notes', { chatId: 'c' }, 2, 'alice', 'member')

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('DELETE DENIED'),
    })
    expect((db.prepare('SELECT COUNT(*) AS n FROM c_own_notes').get() as { n: number }).n).toBe(8)
  })

  it('authorizes deleteWhere from delete permission alone, independently of read', () => {
    const deleteOnly: CollectionSchema = {
      ...notes,
      name: 'delete_only_notes',
      permissions: {
        deleter: { read: false, create: false, update: false, delete: true },
        reader: { read: true, create: false, update: false, delete: false },
      },
    }
    const sqlite = makeSql(db)
    ctx = makeToolsContext(sqlite, [deleteOnly])
    ensureCollectionTable(sqlite, deleteOnly)
    insert(db, 'c_delete_only_notes', {
      recordId: 'n1',
      createdBy: 'owner',
      cols: { chatId: 'c', body: 'secret' },
    })

    expect(
      deleteWhere(ctx, deleteOnly.name, { chatId: 'c' }, undefined, 'dana', 'deleter'),
    ).toMatchObject({ success: true, data: { deleted: 1 } })

    insert(db, 'c_delete_only_notes', {
      recordId: 'n2',
      createdBy: 'owner',
      cols: { chatId: 'c', body: 'still here' },
    })
    expect(
      deleteWhere(ctx, deleteOnly.name, { chatId: 'c' }, undefined, 'riley', 'reader'),
    ).toMatchObject({ success: false, error: expect.stringContaining('DELETE DENIED') })
  })

  it('refuses the whole page when the caller may not delete one of the matches', async () => {
    // Same posture as records.delete, applied before anything is removed: a
    // half-applied batch would leave the caller unable to tell what happened.
    seedNotes(db, 'chat-1', 4)

    const denied = deleteWhere(ctx, 'notes', { chatId: 'chat-1' }, undefined, 'reader', 'viewer')

    expect(denied).toMatchObject({ success: false })
    expect((denied as { error: string }).error).toContain('DELETE DENIED')
    expect(noteCount(db, 'chat-1')).toBe(4)
  })

  it('deletes under RBAC when the role is allowed to', async () => {
    seedNotes(db, 'chat-1', 4)

    const allowed = deleteWhere(ctx, 'notes', { chatId: 'chat-1' }, undefined, 'member', 'member')

    expect(allowed).toMatchObject({ success: true, data: { deleted: 4 } })
    expect(noteCount(db, 'chat-1')).toBe(0)
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
    const { tools } = (await listResponse.json()) as { tools: Array<{ name: string }> }
    const toolNames = tools.map((tool) => tool.name)

    expect(new Set(toolNames).size).toBe(toolNames.length)
    expect(toolNames.filter((name) => name.startsWith('yjs.'))).toEqual([
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
      const result = (await executeResponse.json()) as { success: boolean; error?: string }
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
  it('removes the correct awareness client from each subscribed document on disconnect', () => {
    const db = new Database(':memory:')
    createYjsTable(db)
    const sql = makeSql(db)
    const body = { collection: 'docs', recordId: 'doc-1', fieldName: 'body' }
    const title = { collection: 'docs', recordId: 'doc-1', fieldName: 'title' }
    const bodyKey = getYjsDocKey(body.collection, body.recordId, body.fieldName)
    const titleKey = getYjsDocKey(title.collection, title.recordId, title.fieldName)
    const attachment: ConnectionAttachment = {
      ...yjsAttachment(body),
      yjsSubscriptions: [body, title],
      awarenessClientIds: { [bodyKey]: 11, [titleKey]: 22 },
    }
    const peer = makeSocket({
      ...yjsAttachment(body),
      yjsSubscriptions: [body, title],
    })
    const sent: Uint8Array[] = []
    const ctx: YjsContext = {
      ...makeYjsContext(sql, {
        getWebSockets: () => [peer],
      } as unknown as DurableObjectState),
      sendBinary: (_ws, data) => sent.push(data),
    }

    handleYjsDisconnect(ctx, makeSocket(attachment), attachment)

    const removals = sent.map((frame) => {
      const decoder = createDecoder(frame)
      expect(readVarUint(decoder)).toBe(MSG_YJS_AWARENESS)
      const docKey = new TextDecoder().decode(readVarUint8Array(decoder))
      const payload = createDecoder(readVarUint8Array(decoder))
      expect(readVarUint(payload)).toBe(1)
      const clientId = readVarUint(payload)
      readVarUint(payload) // clock
      const state = new TextDecoder().decode(readVarUint8Array(payload))
      return { docKey, clientId, state }
    })

    expect(removals).toEqual([
      { docKey: bodyKey, clientId: 11, state: 'null' },
      { docKey: titleKey, clientId: 22, state: 'null' },
    ])
    db.close()
  })

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

// ---------------------------------------------------------------------------
// user.list — the tool and the socket answer the same question, so they must
// answer it the same way. The tool used to read the users table directly and
// hand any caller every row, emails included, regardless of the room's users
// policy: the same member's `useUsers()` roster and `useQuery('users')` obeyed
// `roster: 'read-policy'` while this one did not.
// ---------------------------------------------------------------------------

/** Execute a tool as a real caller: identity by header, no app-action bypass. */
async function execToolAs(
  ctx: ToolsApiContext,
  tool: string,
  headers: Record<string, string>,
): Promise<{ success: boolean; error?: string; data: { users: Array<Record<string, unknown>> } }> {
  const request = new Request('https://internal/api/tools/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ tool, params: {} }),
  })
  const res = await handleToolsRequest(ctx, request, 'tools/execute')
  return res.json() as Promise<Awaited<ReturnType<typeof execToolAs>>>
}

function usersSchemaWith(extra: Partial<CollectionSchema> = {}): CollectionSchema {
  return {
    ...BASE_USERS_SCHEMA,
    columns: [
      ...BASE_USERS_SCHEMA.columns,
      { name: 'privateNote', storage: 'text', interpretation: 'plain' },
    ],
    ...extra,
  }
}

async function seedRoster(schema: CollectionSchema): Promise<{
  db: Database.Database
  ctx: ToolsApiContext
}> {
  const db = new Database(':memory:')
  const sql = makeSql(db)
  const ctx = makeToolsContext(sql, [schema])
  ensureCollectionTable(sql, schema)
  await registerUser(
    sql,
    'admin',
    'Admin',
    'admin@example.test',
    undefined,
    true,
    'member',
    ctx.schemaRegistry,
  )
  await registerUser(
    sql,
    'member',
    'Member',
    'member@example.test',
    undefined,
    false,
    'member',
    ctx.schemaRegistry,
  )
  sql.exec(`UPDATE c_users SET col_privatenote = ? WHERE _row_id = ?`, 'private', 'member')
  return { db, ctx }
}

describe('user.list', () => {
  it('gives a non-admin the public projection, never the directory of emails', async () => {
    const { db, ctx } = await seedRoster(usersSchemaWith())

    const out = await execToolAs(ctx, 'user.list', { 'X-User-Id': 'member' })

    expect(out.success).toBe(true)
    expect(out.data.users.map((u) => u.id).sort()).toEqual(['admin', 'member'])
    for (const user of out.data.users) {
      expect(user).not.toHaveProperty('email')
      expect(user).not.toHaveProperty('privateNote')
      // Presence is public — `usePresence()` needs it.
      expect(user.lastSeenAt).toEqual(expect.any(String))
    }
    expect(JSON.stringify(out.data.users)).not.toContain('@example.test')
    db.close()
  })

  it('gives an admin whole rows, still through the users read policy', async () => {
    const { db, ctx } = await seedRoster(usersSchemaWith())

    const out = await execToolAs(ctx, 'user.list', { 'X-User-Id': 'admin' })

    expect(out.data.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'member',
          email: 'member@example.test',
          privateNote: 'private',
        }),
      ]),
    )
    db.close()
  })

  it("honors roster: 'read-policy' and an explicit read: false, exactly as the socket does", async () => {
    const scoped = await seedRoster(
      usersSchemaWith({
        roster: 'read-policy',
        permissions: {
          '*': { read: 'own', create: false, update: false, delete: false },
          admin: BASE_USERS_SCHEMA.permissions.admin,
        },
      }),
    )
    const scopedOut = await execToolAs(scoped.ctx, 'user.list', { 'X-User-Id': 'member' })
    expect(scopedOut.data.users.map((u) => u.id)).toEqual(['member'])
    scoped.db.close()

    const closed = await seedRoster(
      usersSchemaWith({
        permissions: {
          '*': { read: false, create: false, update: false, delete: false },
          admin: BASE_USERS_SCHEMA.permissions.admin,
        },
      }),
    )
    const closedOut = await execToolAs(closed.ctx, 'user.list', { 'X-User-Id': 'member' })
    expect(closedOut.data.users).toEqual([])
    closed.db.close()
  })

  it('returns nothing to a caller with no identity', async () => {
    const { db, ctx } = await seedRoster(usersSchemaWith())

    const out = await execToolAs(ctx, 'user.list', {})

    expect(out).toMatchObject({ success: true, data: { users: [] } })
    db.close()
  })

  it('keeps whole rows for an app action, which is RBAC-off by contract', async () => {
    const { db, ctx } = await seedRoster(usersSchemaWith())

    const out = await execToolAs(ctx, 'user.list', { 'X-App-Action': 'true' })

    expect(out.data.users).toEqual(
      expect.arrayContaining([expect.objectContaining({ email: 'member@example.test' })]),
    )
    db.close()
  })
})
