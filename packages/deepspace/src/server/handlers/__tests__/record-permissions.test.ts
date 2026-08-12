import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { CollectionSchema } from '../../../shared/types'
import { getRecord, putRecord, type RecordContext } from '../records'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import { SchemaRegistry, noopPermissionContext } from '../../schemas/registry'

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
  name: 'tasks',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true },
    { name: 'claimedById', storage: 'text', interpretation: 'plain' },
    { name: 'internalState', storage: 'text', interpretation: 'plain', default: 'pending' },
  ],
  ownerField: 'claimedById',
  permissions: {
    member: {
      read: true,
      create: true,
      update: 'unclaimed-or-own',
      delete: 'own',
      writableFields: ['title', 'claimedById'],
    },
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

describe('claimable record ownership', () => {
  it('enforces writableFields on create without rejecting server defaults', () => {
    const ctx = makeContext()
    expect(
      putRecord(
        ctx,
        'tasks',
        'forged-state',
        { title: 'Forged', internalState: 'approved' },
        'user-1',
        'member',
      ),
    ).toMatchObject({
      success: false,
      error: "FIELD ERROR: Role 'member' cannot modify field 'internalState'",
    })

    expect(putRecord(ctx, 'tasks', 'safe', { title: 'Safe' }, 'user-1', 'member')).toMatchObject({
      success: true,
    })
    expect(getRecord(ctx.sql, 'tasks', 'safe', schema)?.data.internalState).toBe('pending')
  })

  it('rejects another user id on both create and claim', () => {
    const ctx = makeContext()
    const forgedCreate = putRecord(
      ctx,
      'tasks',
      'forged',
      { title: 'Forged', claimedById: 'user-2' },
      'user-1',
      'member',
    )
    expect(forgedCreate).toMatchObject({ success: false })

    expect(putRecord(ctx, 'tasks', 'task-1', { title: 'Open' }, 'user-1', 'member')).toMatchObject({
      success: true,
    })
    const forgedClaim = putRecord(
      ctx,
      'tasks',
      'task-1',
      { claimedById: 'user-2' },
      'user-1',
      'member',
    )
    expect(forgedClaim).toMatchObject({ success: false })
  })

  it('rejects physical column ids and name/id collisions before persistence', () => {
    const ctx = makeContext()
    expect(
      putRecord(
        ctx,
        'tasks',
        'alias-only',
        { title: 'Forged', col_claimedbyid: 'user-2' },
        'user-1',
        'member',
      ),
    ).toMatchObject({ success: false })
    expect(
      putRecord(
        ctx,
        'tasks',
        'collision',
        { title: 'Forged', claimedById: 'user-1', col_claimedbyid: 'user-2' },
        'user-1',
        'member',
      ),
    ).toMatchObject({ success: false })

    expect(putRecord(ctx, 'tasks', 'task-1', { title: 'Open' }, 'user-1', 'member')).toMatchObject({
      success: true,
    })
    expect(
      putRecord(ctx, 'tasks', 'task-1', { col_claimedbyid: 'user-2' }, 'user-1', 'member'),
    ).toMatchObject({ success: false })
    expect(getRecord(ctx.sql, 'tasks', 'task-1', schema)?.data.claimedById).toBeUndefined()
  })

  it('allows self-claim, self-unclaim, and trusted admin assignment', () => {
    const ctx = makeContext()
    expect(putRecord(ctx, 'tasks', 'task-1', { title: 'Open' }, 'user-1', 'member')).toMatchObject({
      success: true,
    })
    expect(
      putRecord(ctx, 'tasks', 'task-1', { claimedById: 'user-1' }, 'user-1', 'member'),
    ).toMatchObject({ success: true })
    expect(
      putRecord(ctx, 'tasks', 'task-1', { claimedById: null }, 'user-1', 'member'),
    ).toMatchObject({ success: true })
    expect(getRecord(ctx.sql, 'tasks', 'task-1', schema)?.data.claimedById).toBeUndefined()
    expect(
      putRecord(
        ctx,
        'tasks',
        'admin-task',
        { title: 'Assigned', claimedById: 'user-2' },
        'admin-1',
        'admin',
      ),
    ).toMatchObject({ success: true })
  })
})
