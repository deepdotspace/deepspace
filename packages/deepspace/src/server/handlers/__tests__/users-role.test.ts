import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ConnectionAttachment } from '../../../shared/protocol/types'
import type { CollectionSchema } from '../../../shared/types'
import { BASE_USERS_SCHEMA, noopPermissionContext, SchemaRegistry } from '../../schemas/registry'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import { broadcastUserList, getUser, handleSetRole, handleUserList, registerUser, type UserContext } from '../users'

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

function socket(attachment: ConnectionAttachment) {
  const close = vi.fn()
  return {
    ws: {
      deserializeAttachment: () => attachment,
      close,
    } as unknown as WebSocket,
    close,
  }
}

/** Roster order follows `_created_at DESC`, which ties within a test run. */
function byId(users: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...users].sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

describe('user role revocation', () => {
  it('closes changed-user sockets and filters the admin refresh through users RBAC', async () => {
    const db = new Database(':memory:')
    const sql = makeSql(db)
    const usersSchema: CollectionSchema = {
      ...BASE_USERS_SCHEMA,
      columns: [
        ...BASE_USERS_SCHEMA.columns,
        { name: 'privateNote', storage: 'text', interpretation: 'plain' },
      ],
      permissions: {
        ...BASE_USERS_SCHEMA.permissions,
        admin: { ...BASE_USERS_SCHEMA.permissions.admin, read: 'own' },
      },
    }
    const schemaRegistry = new SchemaRegistry([usersSchema])
    ensureCollectionTable(sql, usersSchema)
    await registerUser(
      sql,
      'admin',
      'Admin',
      'admin@example.test',
      undefined,
      true,
      'member',
      schemaRegistry,
    )
    await registerUser(
      sql,
      'target',
      'Target',
      'target@example.test',
      undefined,
      false,
      'member',
      schemaRegistry,
    )
    sql.exec(`UPDATE c_users SET col_privatenote = ? WHERE _row_id = ?`, 'private', 'target')

    const adminAttachment: ConnectionAttachment = {
      userId: 'admin',
      userName: 'Admin',
      userEmail: 'admin@example.test',
      role: 'admin',
      subscriptions: [],
      yjsSubscriptions: [],
    }
    const targetAttachment: ConnectionAttachment = {
      userId: 'target',
      userName: 'Target',
      userEmail: 'target@example.test',
      role: 'member',
      subscriptions: [],
      yjsSubscriptions: [],
    }
    const bystanderAttachment: ConnectionAttachment = {
      userId: 'bystander',
      userName: 'Bystander',
      userEmail: 'bystander@example.test',
      role: 'member',
      subscriptions: [],
      yjsSubscriptions: [],
    }
    const admin = socket(adminAttachment)
    const first = socket({ ...targetAttachment })
    const second = socket({ ...targetAttachment })
    const bystander = socket(bystanderAttachment)
    const send = vi.fn()
    const ctx: UserContext = {
      sql,
      schemaRegistry,
      state: {
        getWebSockets: () => [admin.ws, first.ws, second.ws, bystander.ws],
      } as unknown as DurableObjectState,
      getPermissionContext: () => noopPermissionContext,
      send,
    }

    await handleSetRole(ctx, admin.ws, adminAttachment, {
      userId: 'target',
      role: 'viewer',
    })

    expect(first.close).toHaveBeenCalledWith(1008, 'role-changed')
    expect(second.close).toHaveBeenCalledWith(1008, 'role-changed')
    expect(admin.close).not.toHaveBeenCalled()
    expect(bystander.close).not.toHaveBeenCalled()
    expect(getUser(sql, 'target', schemaRegistry)?.role).toBe('viewer')

    // The closed sockets are skipped by identity — no roster frame lands on a
    // connection being torn down for holding the old role.
    expect(send.mock.calls.filter((call) => call[0] === first.ws)).toHaveLength(0)
    expect(send.mock.calls.filter((call) => call[0] === second.ws)).toHaveLength(0)

    const rosterSentTo = (ws: WebSocket) =>
      send.mock.calls.filter((call) => call[0] === ws).at(-1)?.[1].payload.users as Array<
        Record<string, unknown>
      >
    // The admin's refresh still runs through the row policy (`read: 'own'`).
    const refreshedUsers = rosterSentTo(admin.ws)
    expect(refreshedUsers.map((user) => user.id)).toEqual(['admin'])
    expect(refreshedUsers[0]).not.toHaveProperty('privateNote')
    // A member's tab gets the refreshed public roster too — with the new
    // role visible and nothing beyond public identity.
    const bystanderUsers = rosterSentTo(bystander.ws)
    expect(bystanderUsers.find((user) => user.id === 'target')).toMatchObject({ role: 'viewer' })
    for (const user of bystanderUsers) {
      expect(user).not.toHaveProperty('privateNote')
      expect(user).not.toHaveProperty('email')
    }
    db.close()
  })
})

describe('user list visibility', () => {
  it('hides the directory from anonymous callers and limits non-admins to public identity', async () => {
    const db = new Database(':memory:')
    const sql = makeSql(db)
    const usersSchema: CollectionSchema = {
      ...BASE_USERS_SCHEMA,
      columns: [
        ...BASE_USERS_SCHEMA.columns,
        { name: 'privateNote', storage: 'text', interpretation: 'plain' },
      ],
      permissions: {
        ...BASE_USERS_SCHEMA.permissions,
        directory: { read: true, create: false, update: false, delete: false },
      },
    }
    const schemaRegistry = new SchemaRegistry([usersSchema])
    ensureCollectionTable(sql, usersSchema)
    await registerUser(
      sql,
      'admin',
      'Admin',
      'admin@example.test',
      undefined,
      true,
      'member',
      schemaRegistry,
    )
    await registerUser(
      sql,
      'member',
      'Member',
      'member@example.test',
      'https://example.test/member.png',
      false,
      'member',
      schemaRegistry,
    )
    sql.exec(`UPDATE c_users SET col_privatenote = ? WHERE _row_id = ?`, 'private', 'member')

    const send = vi.fn()
    const ctx: UserContext = {
      sql,
      schemaRegistry,
      state: { getWebSockets: () => [] } as unknown as DurableObjectState,
      getPermissionContext: () => noopPermissionContext,
      send,
    }
    const ws = {} as WebSocket

    handleUserList(ctx, ws, {
      userId: 'anon-test',
      userName: 'Anonymous',
      userEmail: '',
      role: 'viewer',
      subscriptions: [],
      yjsSubscriptions: [],
    })
    expect(send).toHaveBeenLastCalledWith(ws, {
      type: 'user.list',
      payload: { users: [] },
    })

    handleUserList(ctx, ws, {
      userId: 'member',
      userName: 'Member',
      userEmail: 'member@example.test',
      role: 'member',
      subscriptions: [],
      yjsSubscriptions: [],
    })
    const memberUsers = send.mock.calls.at(-1)?.[1].payload.users as Array<Record<string, unknown>>
    expect(byId(memberUsers)).toEqual([
      { id: 'admin', name: 'Admin', role: 'admin' },
      {
        id: 'member',
        name: 'Member',
        imageUrl: 'https://example.test/member.png',
        role: 'member',
      },
    ])
    for (const user of memberUsers) {
      expect(user).not.toHaveProperty('email')
      expect(user).not.toHaveProperty('createdAt')
      expect(user).not.toHaveProperty('lastSeenAt')
      expect(user).not.toHaveProperty('privateNote')
    }

    handleUserList(ctx, ws, {
      userId: 'member',
      userName: 'Member',
      userEmail: 'member@example.test',
      role: 'directory',
      subscriptions: [],
      yjsSubscriptions: [],
    })
    const directoryUsers = send.mock.calls.at(-1)?.[1].payload.users as Array<
      Record<string, unknown>
    >
    expect(directoryUsers.map((user) => user.id)).toEqual(
      expect.arrayContaining(['admin', 'member']),
    )
    for (const user of directoryUsers) {
      expect(user).not.toHaveProperty('email')
      expect(user).not.toHaveProperty('privateNote')
    }

    handleUserList(ctx, ws, {
      userId: 'admin',
      userName: 'Admin',
      userEmail: 'admin@example.test',
      role: 'admin',
      subscriptions: [],
      yjsSubscriptions: [],
    })
    const adminUsers = send.mock.calls.at(-1)?.[1].payload.users as Array<Record<string, unknown>>
    expect(adminUsers).toEqual(
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

  it('gives members the whole roster in a room carrying only BASE_USERS_SCHEMA', async () => {
    // A `chat:*` room registers SYSTEM + BASE_USERS_SCHEMA + messagingSchemas,
    // so its users policy is `'*': { read: 'own' }` — the row policy that used
    // to reduce every peer to nothing and render them as "Unknown".
    const db = new Database(':memory:')
    const sql = makeSql(db)
    const schemaRegistry = new SchemaRegistry([BASE_USERS_SCHEMA])
    ensureCollectionTable(sql, BASE_USERS_SCHEMA)
    await registerUser(sql, 'alice', 'Alice', 'alice@example.test', undefined, false, 'member', schemaRegistry)
    await registerUser(sql, 'bob', 'Bob', 'bob@example.test', 'https://example.test/bob.png', false, 'member', schemaRegistry)

    const send = vi.fn()
    const ctx: UserContext = {
      sql,
      schemaRegistry,
      state: { getWebSockets: () => [] } as unknown as DurableObjectState,
      getPermissionContext: () => noopPermissionContext,
      send,
    }
    const ws = {} as WebSocket

    handleUserList(ctx, ws, {
      userId: 'alice',
      userName: 'Alice',
      userEmail: 'alice@example.test',
      role: 'member',
      subscriptions: [],
      yjsSubscriptions: [],
    })

    const users = send.mock.calls.at(-1)?.[1].payload.users as Array<Record<string, unknown>>
    expect(byId(users)).toEqual([
      { id: 'alice', name: 'Alice', role: 'member' },
      { id: 'bob', name: 'Bob', imageUrl: 'https://example.test/bob.png', role: 'member' },
    ])
    for (const user of users) {
      expect(user).not.toHaveProperty('email')
      expect(user).not.toHaveProperty('createdAt')
      expect(user).not.toHaveProperty('lastSeenAt')
    }
    expect(JSON.stringify(users)).not.toContain('@example.test')

    db.close()
  })

  it('keeps the roster empty for a role whose users policy is an explicit `read: false`', async () => {
    // `read: false` is a statement ("members may not read users"), not a row
    // filter — unlike `'own'`, it must survive the projection unchanged.
    const closed = {
      ...BASE_USERS_SCHEMA,
      permissions: {
        '*': { read: false as const, create: false as const, update: false as const, delete: false as const },
        admin: BASE_USERS_SCHEMA.permissions.admin,
      },
    }
    const db = new Database(':memory:')
    const sql = makeSql(db)
    const schemaRegistry = new SchemaRegistry([closed])
    ensureCollectionTable(sql, closed)
    await registerUser(sql, 'alice', 'Alice', 'alice@example.test', undefined, false, 'member', schemaRegistry)
    await registerUser(sql, 'root', 'Root', 'root@example.test', undefined, false, 'admin', schemaRegistry)

    const send = vi.fn()
    const ctx: UserContext = {
      sql,
      schemaRegistry,
      state: { getWebSockets: () => [] } as unknown as DurableObjectState,
      getPermissionContext: () => noopPermissionContext,
      send,
    }
    const listFor = (userId: string, role: 'member' | 'admin') => {
      handleUserList(ctx, {} as WebSocket, {
        userId,
        userName: userId,
        userEmail: `${userId}@example.test`,
        role,
        subscriptions: [],
        yjsSubscriptions: [],
      })
      return send.mock.calls.at(-1)?.[1].payload.users as Array<Record<string, unknown>>
    }

    expect(listFor('alice', 'member')).toEqual([])
    expect(byId(listFor('root', 'admin')).map((u) => u.id)).toEqual(['alice', 'root'])

    db.close()
  })

  it("scopes the roster to the caller's read policy when the schema opts in with roster: 'read-policy'", async () => {
    // A tenant/team-partitioned app must not show names across the partition;
    // the knob keeps the row policy authoritative for the roster too.
    const scoped = {
      ...BASE_USERS_SCHEMA,
      roster: 'read-policy' as const,
      permissions: {
        '*': { read: 'own' as const, create: false as const, update: 'own' as const, delete: false as const },
        admin: BASE_USERS_SCHEMA.permissions.admin,
      },
    }
    const db = new Database(':memory:')
    const sql = makeSql(db)
    const schemaRegistry = new SchemaRegistry([scoped])
    ensureCollectionTable(sql, scoped)
    await registerUser(sql, 'alice', 'Alice', 'alice@example.test', undefined, false, 'member', schemaRegistry)
    await registerUser(sql, 'bob', 'Bob', 'bob@example.test', undefined, false, 'member', schemaRegistry)

    const send = vi.fn()
    const ctx: UserContext = {
      sql,
      schemaRegistry,
      state: { getWebSockets: () => [] } as unknown as DurableObjectState,
      getPermissionContext: () => noopPermissionContext,
      send,
    }
    handleUserList(ctx, {} as WebSocket, {
      userId: 'alice',
      userName: 'Alice',
      userEmail: 'alice@example.test',
      role: 'member',
      subscriptions: [],
      yjsSubscriptions: [],
    })

    const users = send.mock.calls.at(-1)?.[1].payload.users as Array<Record<string, unknown>>
    // read: 'own' + read-policy roster → only the caller's own row, still
    // projected to public identity.
    expect(users).toEqual([{ id: 'alice', name: 'Alice', role: 'member' }])

    db.close()
  })

  it('pushes the roster to every other attached socket when it changes', async () => {
    // The client asks for `user.list` once per connection; a peer who
    // registers later must be pushed, or the open tab renders them "Unknown".
    const db = new Database(':memory:')
    const sql = makeSql(db)
    const schemaRegistry = new SchemaRegistry([BASE_USERS_SCHEMA])
    ensureCollectionTable(sql, BASE_USERS_SCHEMA)
    await registerUser(sql, 'alice', 'Alice', 'alice@example.test', undefined, false, 'member', schemaRegistry)
    await registerUser(sql, 'bob', 'Bob', 'bob@example.test', undefined, false, 'member', schemaRegistry)

    const attachmentFor = (userId: string): ConnectionAttachment => ({
      userId,
      userName: userId,
      userEmail: `${userId}@example.test`,
      role: 'member',
      subscriptions: [],
      yjsSubscriptions: [],
    })
    const alice = socket(attachmentFor('alice'))
    const bob = socket(attachmentFor('bob'))
    const unattached = { deserializeAttachment: () => null } as unknown as WebSocket
    const send = vi.fn()
    const ctx: UserContext = {
      sql,
      schemaRegistry,
      state: { getWebSockets: () => [alice.ws, bob.ws, unattached] } as unknown as DurableObjectState,
      getPermissionContext: () => noopPermissionContext,
      send,
    }

    broadcastUserList(ctx, bob.ws)

    expect(send).toHaveBeenCalledTimes(1)
    const [target, message] = send.mock.calls[0]
    expect(target).toBe(alice.ws)
    expect(message.type).toBe('user.list')
    expect(byId(message.payload.users).map((u: Record<string, unknown>) => u.id)).toEqual(['alice', 'bob'])

    db.close()
  })
})
