import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ConnectionAttachment } from '../../../shared/protocol/types'
import { BASE_USERS_SCHEMA, noopPermissionContext, SchemaRegistry } from '../../schemas/registry'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import type { RecordContext } from '../records'
import { getUser, handleUserUpdate, registerUser } from '../users'

/**
 * The users row's identity fields (email, name, imageUrl) come from the auth
 * plane at connect and nowhere else. `email` is the key invites resolve on
 * (the documents feature's owner-only lookup queries `where: { email }`), and
 * `name`/`imageUrl` are what the share dialog shows an owner about a
 * collaborator — so a `user.update` frame, which the SDK client only ever
 * sends empty, must not be able to set any of them.
 */

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

async function makeRoom() {
  const sql = makeSql(new Database(':memory:'))
  const schemaRegistry = new SchemaRegistry([BASE_USERS_SCHEMA])
  ensureCollectionTable(sql, BASE_USERS_SCHEMA)
  const ctx = {
    sql,
    schemaRegistry,
    state: { getWebSockets: () => [] } as unknown as DurableObjectState,
    getPermissionContext: () => noopPermissionContext,
    send: vi.fn(),
    broadcastChange: vi.fn(),
  } as unknown as RecordContext
  return { sql, schemaRegistry, ctx }
}

describe('users.email is owned by the auth plane', () => {
  it('ignores every identity field a client puts on user.update, refreshing only lastSeenAt', async () => {
    const { sql, schemaRegistry, ctx } = await makeRoom()
    await registerUser(
      sql,
      'mallory',
      'Mallory',
      'mallory@example.test',
      undefined,
      false,
      'member',
      schemaRegistry,
    )
    const attachment: ConnectionAttachment = {
      userId: 'mallory',
      userName: 'Mallory',
      userEmail: 'mallory@example.test',
      role: 'member',
      subscriptions: [],
      yjsSubscriptions: [],
    }

    // The SDK client only ever sends `{}`. A hand-crafted frame carrying
    // identity fields — sent to be resolved in a victim's place, or to pose
    // under a colleague's name and avatar in every share dialog — reaches the
    // handler only as the heartbeat it is: the room's dispatch hands no payload
    // down, and the handler has no parameter to take one.
    const before = getUser(sql, 'mallory', schemaRegistry)
    handleUserUpdate(ctx, {} as WebSocket, attachment)

    const row = getUser(sql, 'mallory', schemaRegistry)
    expect(row?.email).toBe('mallory@example.test')
    expect(row?.name).toBe('Mallory')
    expect(row?.imageUrl).toBeUndefined()
    // The frame still does its one job: the presence heartbeat.
    expect(row?.lastSeenAt).toBeTruthy()
    expect((row?.lastSeenAt ?? '') >= (before?.lastSeenAt ?? '')).toBe(true)
  })

  it('stores the email lowercased and trimmed on first registration and on refresh', async () => {
    const { sql, schemaRegistry } = await makeRoom()
    await registerUser(
      sql,
      'cap',
      'Cap',
      '  Cap@Example.Test\n',
      undefined,
      false,
      'member',
      schemaRegistry,
    )
    expect(getUser(sql, 'cap', schemaRegistry)?.email).toBe('cap@example.test')

    await registerUser(
      sql,
      'cap',
      'Cap',
      'CAP@EXAMPLE.TEST',
      undefined,
      false,
      'member',
      schemaRegistry,
    )
    expect(getUser(sql, 'cap', schemaRegistry)?.email).toBe('cap@example.test')
  })

  it('keeps the registered email when a refresh carries none', async () => {
    const { sql, schemaRegistry } = await makeRoom()
    await registerUser(
      sql,
      'keep',
      'Keep',
      'keep@example.test',
      undefined,
      false,
      'member',
      schemaRegistry,
    )
    await registerUser(sql, 'keep', 'Anonymous', '', undefined, false, 'member', schemaRegistry)
    expect(getUser(sql, 'keep', schemaRegistry)?.email).toBe('keep@example.test')
  })
})
