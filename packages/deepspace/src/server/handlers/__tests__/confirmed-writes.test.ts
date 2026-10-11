import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { CollectionSchema } from '../../../shared/types'
import type { ConnectionAttachment } from '../../../shared/protocol/types'
import { ensureWriteLedger, getRecord, handleDelete, handlePut, type RecordContext } from '../records'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import { SchemaRegistry, noopPermissionContext } from '../../schemas/registry'
import { MSG } from '../../../shared/protocol/constants'

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
  } as unknown as SqlStorage
}

/** An append-only log: members may add entries and never change them. */
const events: CollectionSchema = {
  name: 'events',
  columns: [{ name: 'text', storage: 'text', interpretation: 'plain', required: true }],
  permissions: {
    viewer: { read: true, create: true, update: false, delete: false },
    member: { read: true, create: true, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

function harness() {
  const sql = makeSql(new Database(':memory:'))
  ensureCollectionTable(sql, events)
  ensureWriteLedger(sql)
  const acks: Array<{ requestId: string; success: boolean; error?: string }> = []
  const ctx: RecordContext = {
    sql,
    schemaRegistry: new SchemaRegistry([events]),
    state: { getWebSockets: () => [] } as unknown as DurableObjectState,
    getPermissionContext: () => noopPermissionContext,
    send: (_ws, message) => {
      const { type, payload } = message as { type: string; payload: { requestId: string; success: boolean; error?: string } }
      if (type === MSG.ACK) acks.push(payload)
    },
  }
  const ws = {} as WebSocket
  const as = (userId: string, role: string) => ({ userId, role }) as ConnectionAttachment
  return { ctx, ws, acks, as }
}

describe('confirmed-write ledger', () => {
  it('answers a resent create with its first outcome instead of refusing it as an update', () => {
    const { ctx, ws, acks, as } = harness()
    const member = as('user-1', 'member')
    const put = { collection: 'events', recordId: 'e1', data: { text: 'answered' }, requestId: 'r1' }
    handlePut(ctx, ws, member, put)
    // The ACK was lost with the connection; the client sends the same write again.
    handlePut(ctx, ws, member, put)
    expect(acks.map((ack) => ack.success)).toEqual([true, true])
    expect(acks.every((ack) => ack.requestId === 'r1')).toBe(true)

    // A genuinely new write to the same record is still refused.
    handlePut(ctx, ws, member, { ...put, data: { text: 'changed' }, requestId: 'r2' })
    expect(acks.at(-1)).toMatchObject({ requestId: 'r2', success: false })
  })

  it('answers a resent delete with its first outcome', () => {
    const { ctx, ws, acks, as } = harness()
    const admin = as('owner', 'admin')
    handlePut(ctx, ws, admin, { collection: 'events', recordId: 'e1', data: { text: 'x' }, requestId: 'r1' })
    handleDelete(ctx, ws, admin, { collection: 'events', recordId: 'e1', requestId: 'r2' })
    handleDelete(ctx, ws, admin, { collection: 'events', recordId: 'e1', requestId: 'r2' })
    expect(acks.map((ack) => ack.success)).toEqual([true, true, true])
    expect(getRecord(ctx.sql, 'events', 'e1')).toBeNull()
  })

  it('keeps each user’s requestIds apart and replays a refusal as a refusal', () => {
    const { ctx, ws, acks, as } = harness()
    handlePut(ctx, ws, as('user-1', 'member'), { collection: 'events', recordId: 'e1', data: {}, requestId: 'same' })
    handlePut(ctx, ws, as('user-1', 'member'), { collection: 'events', recordId: 'e1', data: {}, requestId: 'same' })
    handlePut(ctx, ws, as('user-2', 'member'), { collection: 'events', recordId: 'e2', data: { text: 'ok' }, requestId: 'same' })
    expect(acks.map((ack) => ack.success)).toEqual([false, false, true])
    expect(acks[0].error).toBe(acks[1].error)
  })

  it('answers an anonymous resend, which arrives under a new socket id, with its first outcome', () => {
    const { ctx, ws, acks, as } = harness()
    const put = { collection: 'events', recordId: 'e1', data: { text: 'hello' }, requestId: 'r1' }
    handlePut(ctx, ws, as('anon-first-socket', 'viewer'), put)
    handlePut(ctx, ws, as('anon-second-socket', 'viewer'), put)
    expect(acks.map((ack) => ack.success)).toEqual([true, true])
  })
})
