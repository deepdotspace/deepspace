import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import type { CollectionSchema } from '../../../shared/types'
import { MSG } from '../../../shared/protocol/constants'
import { deleteRecord, getRecord, putRecord, type RecordContext } from '../records'
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

function makeContext(collectionSchema: CollectionSchema = schema): RecordContext {
  const sql = makeSql(new Database(':memory:'))
  ensureCollectionTable(sql, collectionSchema)
  return {
    sql,
    schemaRegistry: new SchemaRegistry([collectionSchema]),
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

describe('live read access', () => {
  function setup(overrides: Partial<CollectionSchema> = {}) {
    const collectionSchema: CollectionSchema = {
      name: 'documents',
      columns: [
        { name: 'title', storage: 'text', interpretation: 'plain' },
        { name: 'collaborators', storage: 'text', interpretation: { kind: 'json' } },
        { name: 'assignedTo', storage: 'text', interpretation: 'plain' },
        { name: 'status', storage: 'text', interpretation: 'plain' },
        { name: 'teamId', storage: 'text', interpretation: 'plain' },
      ],
      collaboratorsField: 'collaborators',
      permissions: {
        member: { read: 'collaborator', create: true, update: 'own', delete: 'own' },
        admin: { read: true, create: true, update: true, delete: true },
      },
      ...overrides,
    }
    const ctx = makeContext(collectionSchema)
    const sockets = Object.fromEntries(
      ['owner', 'reader', 'remaining', 'unrelated', 'admin'].map((userId) => [
        userId,
        {
          deserializeAttachment: () => ({ userId, role: userId === 'admin' ? 'admin' : 'member' }),
        } as unknown as WebSocket,
      ]),
    )
    ctx.state = { getWebSockets: () => Object.values(sockets) } as unknown as DurableObjectState
    const send = vi.fn<RecordContext['send']>()
    ctx.send = send
    const messagesFor = (userId: string) =>
      send.mock.calls.filter(([ws]) => ws === sockets[userId]).map(([, message]) => message)
    const save = (data: Record<string, unknown>) => {
      expect(putRecord(ctx, 'documents', 'doc-1', data, 'owner', 'admin').success).toBe(true)
    }
    return { ctx, send, messagesFor, save }
  }

  it.each([
    [
      'collaborator removal',
      'collaborator',
      {},
      { collaborators: ['reader', 'remaining'] },
      { collaborators: ['remaining'] },
    ],
    [
      'ownership transfer',
      'own',
      { ownerField: 'assignedTo' },
      { assignedTo: 'reader' },
      { assignedTo: 'remaining' },
    ],
    [
      'unpublishing',
      'published',
      { visibilityField: { field: 'status', value: 'published' } },
      { status: 'published' },
      { status: 'draft' },
    ],
    ['moving teams', 'team', { teamField: 'teamId' }, { teamId: 'team-a' }, { teamId: 'team-b' }],
  ] as const)(
    'removes the old reader after %s without sending private contents',
    (_name, read, fields, before, after) => {
      const h = setup({
        ...fields,
        permissions: {
          member: { read, create: false, update: false, delete: false },
          admin: { read: true, create: true, update: true, delete: true },
        },
      })
      h.ctx.getPermissionContext = () => ({
        isTeamMember: (teamId, userId) =>
          (teamId === 'team-a' && userId === 'reader') ||
          (teamId === 'team-b' && userId === 'remaining'),
      })
      h.save({ title: 'Initially readable', ...before })
      expect(h.messagesFor('reader')).toMatchObject([{ payload: { changeType: 'create' } }])
      h.send.mockClear()

      h.save({ title: 'New private contents', ...after })

      expect(h.messagesFor('reader')).toEqual([
        {
          type: MSG.RECORD_CHANGE,
          payload: { collection: 'documents', record: { recordId: 'doc-1' }, changeType: 'delete' },
        },
      ])
      expect(h.messagesFor('admin')).toMatchObject([
        {
          payload: { changeType: 'update', record: { data: { title: 'New private contents' } } },
        },
      ])
      expect(
        getRecord(h.ctx.sql, 'documents', 'doc-1', h.ctx.schemaRegistry.get('documents')),
      ).toMatchObject({ data: { title: 'New private contents' } })
      if (read !== 'published') expect(h.messagesFor('unrelated')).toEqual([])
    },
  )

  it('keeps remaining readers current, restores access, and stays silent for excluded users', () => {
    const h = setup()
    h.save({ title: 'Shared', collaborators: ['reader', 'remaining'] })
    expect(h.messagesFor('unrelated')).toEqual([])
    h.send.mockClear()
    h.save({ collaborators: ['remaining'] })
    expect(h.messagesFor('remaining')).toMatchObject([{ payload: { changeType: 'update' } }])
    expect(h.messagesFor('unrelated')).toEqual([])
    h.send.mockClear()

    h.save({ title: 'Still private' })
    expect(h.messagesFor('reader')).toEqual([])
    expect(h.messagesFor('unrelated')).toEqual([])
    h.save({ collaborators: ['reader', 'remaining'] })
    expect(h.messagesFor('reader')).toMatchObject([
      {
        payload: { changeType: 'update', record: { data: { title: 'Still private' } } },
      },
    ])
  })

  it('does not remove a reader who still has access through publication', () => {
    const h = setup({
      visibilityField: { field: 'status', value: 'published' },
      permissions: {
        member: { read: 'shared', create: true, update: 'own', delete: 'own' },
        admin: { read: true, create: true, update: true, delete: true },
      },
    })
    h.save({ collaborators: ['reader'], status: 'published' })
    h.send.mockClear()
    h.save({ collaborators: [] })
    expect(h.messagesFor('reader')).toMatchObject([{ payload: { changeType: 'update' } }])
  })

  it('keeps actual deletions restricted to current readers', () => {
    const h = setup()
    h.save({ collaborators: ['reader'] })
    h.send.mockClear()
    expect(deleteRecord(h.ctx, 'documents', 'doc-1', 'owner', 'admin').success).toBe(true)
    expect(h.messagesFor('reader')).toMatchObject([{ payload: { changeType: 'delete' } }])
    expect(h.messagesFor('unrelated')).toEqual([])
  })
})
