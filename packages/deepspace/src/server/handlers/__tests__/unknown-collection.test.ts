/**
 * A record room only serves the collections it was constructed with. Records
 * are sharded across rooms by scope (`app:*`, `chat:*`, `conv:*`, …), so asking
 * a room for a collection that lives in a different scope is a routing mistake.
 *
 * `records.query` used to answer that with `{ success: true, records: [], count: 0 }`
 * — indistinguishable from a collection that is genuinely empty, and the reason
 * an evaluator spent 20 minutes querying the app-wide room for per-channel data.
 * Every `records.*` tool now fails instead, naming the collection, the room, and
 * what that room does serve.
 *
 * The one thing that must NOT change: the `Schema not registered for
 * collection: <name>` prefix. The scaffolded Yjs route probes for an optional
 * `documents` collection with `startsWith` on exactly that text.
 */

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { handleToolsRequest, type ToolsApiContext } from '../tools-api'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import {
  SchemaRegistry,
  noopPermissionContext,
  type CollectionSchema,
} from '../../schemas/registry'

function makeSql(db: Database.Database): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]): { toArray: () => unknown[] } {
      const isSelect = /^(SELECT|PRAGMA)/i.test(query.trim())
      if (bindings.length === 0 && !isSelect) {
        db.exec(query)
        return { toArray: () => [] }
      }
      const statement = db.prepare(query)
      if (isSelect) return { toArray: () => statement.all(...bindings) }
      statement.run(...bindings)
      return { toArray: () => [] }
    },
    get databaseSize(): number {
      return 0
    },
    Cursor: undefined as unknown as SqlStorage['Cursor'],
    Statement: undefined as unknown as SqlStorage['Statement'],
  } as unknown as SqlStorage
}

const channelsSchema: CollectionSchema = {
  name: 'channels',
  columns: [{ name: 'name', storage: 'text', interpretation: 'plain' }],
  permissions: { '*': { read: true, create: true, update: true, delete: true } },
}

const SCOPE_ID = 'app:app_01test'

function makeContext(): ToolsApiContext {
  const sql = makeSql(new Database(':memory:'))
  ensureCollectionTable(sql, channelsSchema)
  return {
    sql,
    schemaRegistry: new SchemaRegistry([channelsSchema]),
    scopeId: SCOPE_ID,
    state: { getWebSockets: () => [] } as unknown as DurableObjectState,
    getPermissionContext: () => noopPermissionContext,
    send: () => {},
    yjsDocs: new Map(),
    sendBinary: () => {},
  }
}

async function callTool(
  ctx: ToolsApiContext,
  tool: string,
  params: Record<string, unknown>,
): Promise<{ success?: boolean; error?: string; data?: Record<string, unknown> }> {
  const res = await handleToolsRequest(
    ctx,
    new Request('https://do/api/tools/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Action': 'true' },
      body: JSON.stringify({ tool, params }),
    }),
    'tools/execute',
  )
  return res.json()
}

describe('collections the room does not serve', () => {
  it('fails records.query instead of returning an empty success', async () => {
    const ctx = makeContext()

    const result = await callTool(ctx, 'records.query', { collection: 'messages' })

    expect(result.success).toBe(false)
    // The collection asked for, the room it was asked of, and what that room has.
    expect(result.error).toContain('messages')
    expect(result.error).toContain(SCOPE_ID)
    expect(result.error).toContain('channels')
    expect(result.data).toBeUndefined()
  })

  it('fails get, create, update and delete the same way', async () => {
    const ctx = makeContext()

    const calls = [
      ['records.get', { collection: 'messages', recordId: 'm1' }],
      ['records.create', { collection: 'messages', recordId: 'm1', data: { content: 'hi' } }],
      ['records.update', { collection: 'messages', recordId: 'm1', data: { content: 'hi' } }],
      ['records.delete', { collection: 'messages', recordId: 'm1' }],
    ] as const

    for (const [tool, params] of calls) {
      const result = await callTool(ctx, tool, params)
      expect(result.success, `${tool} should be refused`).toBe(false)
      expect(result.error).toContain(SCOPE_ID)
      expect(result.error).toContain('channels')
    }
  })

  it('keeps the prefix the scaffolded documents probe matches on', async () => {
    const ctx = makeContext()

    const result = await callTool(ctx, 'records.get', {
      collection: 'documents',
      recordId: 'doc-1',
    })

    // templates/base/src/server/realtime-routes.ts does exactly this test to
    // decide "this app has no documents collection" rather than "lookup failed".
    expect(result.error?.startsWith('Schema not registered for collection: documents')).toBe(true)
  })

  it('still reports a genuinely empty known collection as success', async () => {
    const ctx = makeContext()

    const result = await callTool(ctx, 'records.query', { collection: 'channels' })

    expect(result).toMatchObject({ success: true, data: { records: [], count: 0 } })
  })
})
