import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { ConnectionAttachment } from '../../../shared/protocol/types'
import { BASE_USERS_SCHEMA, SchemaRegistry } from '../../schemas/registry'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import { getUser, handleSetRole, registerUser, type UserContext } from '../users'

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
  it('closes every live socket for the changed user instead of mutating stale attachments', async () => {
    const db = new Database(':memory:')
    const sql = makeSql(db)
    const schemaRegistry = new SchemaRegistry([BASE_USERS_SCHEMA])
    ensureCollectionTable(sql, BASE_USERS_SCHEMA)
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
    const ctx: UserContext = {
      sql,
      schemaRegistry,
      state: {
        getWebSockets: () => [admin.ws, first.ws, second.ws],
      } as unknown as DurableObjectState,
      send: vi.fn(),
    }

    await handleSetRole(ctx, admin.ws, adminAttachment, {
      userId: 'target',
      role: 'viewer',
    })

    expect(first.close).toHaveBeenCalledWith(1008, 'role-changed')
    expect(second.close).toHaveBeenCalledWith(1008, 'role-changed')
    expect(admin.close).not.toHaveBeenCalled()
    expect(getUser(sql, 'target', schemaRegistry)?.role).toBe('viewer')
    db.close()
  })
})
