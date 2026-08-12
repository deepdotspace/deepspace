import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ConnectionAttachment } from '../../../shared/protocol/types'
import type { CollectionSchema } from '../../../shared/types'
import { BASE_USERS_SCHEMA, noopPermissionContext, SchemaRegistry } from '../../schemas/registry'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import { getUser, handleSetRole, handleUserList, registerUser, type UserContext } from '../users'

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
    const admin = socket(adminAttachment)
    const first = socket({ ...targetAttachment })
    const second = socket({ ...targetAttachment })
    const send = vi.fn()
    const ctx: UserContext = {
      sql,
      schemaRegistry,
      state: {
        getWebSockets: () => [admin.ws, first.ws, second.ws],
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
    expect(getUser(sql, 'target', schemaRegistry)?.role).toBe('viewer')
    const refreshedUsers = send.mock.calls.at(-1)?.[1].payload.users as Array<
      Record<string, unknown>
    >
    expect(refreshedUsers.map((user) => user.id)).toEqual(['admin'])
    expect(refreshedUsers[0]).not.toHaveProperty('privateNote')
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
    expect(memberUsers).toEqual([
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
})
