/**
 * Chat-history helpers against a REAL RecordRoom tools API (better-sqlite3
 * behind the SqlStorage shim + `handleToolsRequest`) rather than a
 * hand-written stub, so paging, RBAC posture, and the actual SQL DELETEs are
 * the thing under test. Complements `chat-history.test.ts`, which pins the
 * helpers' subrequest shapes with a stub.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  appendMessage,
  createChat,
  deleteChatCascade,
  getChat,
  loadMessages,
  updateChat,
} from '../chat-history'
import { handleToolsRequest, type ToolsApiContext } from '../../handlers/tools-api'
import { AI_CHATS_SCHEMA, AI_MESSAGES_SCHEMA } from '../../schemas/ai-chat'
import { BASE_USERS_SCHEMA, SchemaRegistry, noopPermissionContext } from '../../schemas/registry'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'

const OWNER = 'user-owner'

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
      if (isSelect) return { toArray: () => stmt.all(...bindings) }
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

/** A DO stub whose fetch really runs the room's tools API against sqlite. */
function makeRoom(db: Database.Database) {
  const sql = makeSql(db)
  const ctx: ToolsApiContext = {
    sql,
    schemaRegistry: new SchemaRegistry([BASE_USERS_SCHEMA, AI_CHATS_SCHEMA, AI_MESSAGES_SCHEMA]),
    state: { getWebSockets: () => [] } as unknown as DurableObjectState,
    getPermissionContext: () => noopPermissionContext,
    scopeId: 'app:t2m',
    send: () => {},
    yjsDocs: new Map(),
    sendBinary: () => {},
  } as unknown as ToolsApiContext
  ensureCollectionTable(sql, BASE_USERS_SCHEMA)
  ensureCollectionTable(sql, AI_CHATS_SCHEMA)
  ensureCollectionTable(sql, AI_MESSAGES_SCHEMA)

  const stub = {
    fetch: (req: Request) => handleToolsRequest(ctx, req, 'tools/execute'),
  } as unknown as DurableObjectStub
  return { stub, ctx }
}

const rows = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('chat delete against a real RecordRoom', () => {
  let db: Database.Database
  let stub: DurableObjectStub

  beforeEach(() => {
    db = new Database(':memory:')
    stub = makeRoom(db).stub
  })

  it('a chat deleted mid-stream is not resurrected by the post-stream writes', async () => {
    const chat = await createChat(stub, OWNER, { title: 'draft' })
    expect(await appendMessage(stub, {
      id: 'm1', chatId: chat.recordId, userId: OWNER, role: 'user', content: 'hi',
    })).toBe(true)

    // User hits DELETE while the model is still streaming.
    await deleteChatCascade(stub, chat.recordId, OWNER)

    // The turn finishes and writes what it always writes.
    const appended = await appendMessage(stub, {
      id: 'm2', chatId: chat.recordId, userId: OWNER, role: 'assistant', content: 'answer',
    })
    const titled = await updateChat(stub, chat.recordId, OWNER, { title: 'Generated title' })

    expect(appended).toBe(false)
    expect(titled).toBe(false)
    expect(await getChat(stub, chat.recordId, OWNER)).toBeNull()
    expect(rows(db, 'c_ai_chats')).toBe(0)
    expect(rows(db, 'c_ai_messages')).toBe(0)
  })

  it('a few-hundred-message chat cascades completely, orphaning nothing', async () => {
    const chat = await createChat(stub, OWNER, { title: 'long' })
    const other = await createChat(stub, OWNER, { title: 'bystander' })

    const N = 450 // > 2 pages of 200
    for (let i = 0; i < N; i++) {
      await appendMessage(stub, {
        id: `m${i}`, chatId: chat.recordId, userId: OWNER, role: 'user', content: `msg ${i}`,
      })
    }
    await appendMessage(stub, {
      id: 'keep-1', chatId: other.recordId, userId: OWNER, role: 'user', content: 'untouched',
    })
    expect(rows(db, 'c_ai_messages')).toBe(N + 1)

    await deleteChatCascade(stub, chat.recordId, OWNER)

    expect(await getChat(stub, chat.recordId, OWNER)).toBeNull()
    expect(await loadMessages(stub, chat.recordId, OWNER)).toEqual([])
    // Nothing orphaned, nothing collateral.
    expect(rows(db, 'c_ai_messages')).toBe(1)
    expect(await getChat(stub, other.recordId, OWNER)).not.toBeNull()
    expect(await loadMessages(stub, other.recordId, OWNER)).toHaveLength(1)
  })

  it('the cascade is bounded — pages of 200, not one subrequest per row', async () => {
    const room = makeRoom(new Database(':memory:'))
    const calls: string[] = []
    const counting = {
      fetch: async (req: Request) => {
        const clone = req.clone()
        const body = (await clone.json()) as { tool: string }
        calls.push(body.tool)
        return (room.stub as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(req)
      },
    } as unknown as DurableObjectStub

    const chat = await createChat(counting, OWNER, {})
    for (let i = 0; i < 450; i++) {
      await appendMessage(counting, {
        id: `m${i}`, chatId: chat.recordId, userId: OWNER, role: 'user', content: 'x',
      })
    }
    calls.length = 0

    await deleteChatCascade(counting, chat.recordId, OWNER)

    expect(calls.filter((t) => t === 'records.deleteWhere')).toHaveLength(3)
    expect(calls.filter((t) => t === 'records.delete')).toHaveLength(1)
  })

  it('a second user cannot delete or resurrect the owner\'s chat', async () => {
    const chat = await createChat(stub, OWNER, { title: 'private' })
    await appendMessage(stub, {
      id: 'm1', chatId: chat.recordId, userId: OWNER, role: 'user', content: 'secret',
    })

    expect(await getChat(stub, chat.recordId, 'user-intruder')).toBeNull()
    expect(await updateChat(stub, chat.recordId, 'user-intruder', { title: 'pwned' })).toBe(false)
    expect(await appendMessage(stub, {
      id: 'm2', chatId: chat.recordId, userId: 'user-intruder', role: 'user', content: 'inject',
    })).toBe(false)

    expect((await getChat(stub, chat.recordId, OWNER))?.title).toBe('private')
    expect(rows(db, 'c_ai_messages')).toBe(1)
  })
})
