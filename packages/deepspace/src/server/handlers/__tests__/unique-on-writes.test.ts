import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { CollectionSchema } from '../../../shared/types'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import { SchemaRegistry, noopPermissionContext } from '../../schemas/registry'
import { getRecord, putRecord, type RecordContext } from '../records'

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

const schema: CollectionSchema = {
  name: 'votes',
  columns: [
    { name: 'pollId', storage: 'text', interpretation: 'plain' },
    { id: 'voter_key', name: 'userId', storage: 'text', interpretation: 'plain' },
    { name: 'choice', storage: 'text', interpretation: 'plain' },
  ],
  uniqueOn: ['pollId', 'userId'],
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
  },
}

function makeContext(): RecordContext {
  const sql = makeSql(new Database(':memory:'))
  ensureCollectionTable(sql, schema)
  return {
    sql,
    schemaRegistry: new SchemaRegistry([schema]),
    state: { getWebSockets: () => [] } as unknown as DurableObjectState,
    getPermissionContext: () => noopPermissionContext,
    send: () => {},
  }
}

describe('uniqueOn record writes', () => {
  it('returns a stable duplicate result when an update collides with another row', () => {
    const ctx = makeContext()
    expect(
      putRecord(ctx, 'votes', 'vote-1', { pollId: 'poll-1', userId: 'user-1' }, 'admin', 'admin'),
    ).toMatchObject({ success: true })
    expect(
      putRecord(ctx, 'votes', 'vote-2', { pollId: 'poll-1', userId: 'user-2' }, 'admin', 'admin'),
    ).toMatchObject({ success: true })

    expect(putRecord(ctx, 'votes', 'vote-2', { userId: 'user-1' }, 'admin', 'admin')).toEqual({
      success: false,
      error: 'Duplicate: a record with pollId=poll-1, userId=user-1 already exists in votes',
    })
    expect(getRecord(ctx.sql, 'votes', 'vote-2', schema)?.data.userId).toBe('user-2')
  })

  it('allows an update that keeps its own unique tuple', () => {
    const ctx = makeContext()
    expect(
      putRecord(
        ctx,
        'votes',
        'vote-1',
        { pollId: 'poll-1', userId: 'user-1', choice: 'a' },
        'admin',
        'admin',
      ),
    ).toMatchObject({ success: true })

    expect(putRecord(ctx, 'votes', 'vote-1', { choice: 'b' }, 'admin', 'admin')).toMatchObject({
      success: true,
    })
    expect(getRecord(ctx.sql, 'votes', 'vote-1', schema)?.data.choice).toBe('b')
  })
})
