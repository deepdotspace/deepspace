/**
 * System-managed columns on the `users` collection must never be changed by a
 * silent no-op.
 *
 * `putRecord` preserves `email` / `name` / `imageUrl` / `role` / `createdAt` /
 * `lastSeenAt` on any non-system write, because those columns belong to
 * `registerUser`. Preserving them is right; reporting `{ success: true }` when
 * the caller asked to *change* one is not — a server action calling
 * `tools.update('users', id, { role: 'admin' })` used to get success back with
 * nothing written and no error to follow.
 *
 * Two behaviours are locked down together, and they pull in opposite
 * directions: an attempted change is a failure, while a client that echoes the
 * record it just read (system columns included) still succeeds.
 *
 * Setup mirrors `record-permissions.test.ts`: an in-memory better-sqlite3
 * instance behind a small `SqlStorage` shim, with the collection table
 * materialised by the real migration helper.
 */

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getRecord, putRecord, type RecordContext } from '../records'
import { registerUser } from '../users'
import type { ToolResult } from '../../utils/tools'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'
import {
  BASE_USERS_SCHEMA,
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

/** An app users schema: the standard columns plus one app-owned column. */
const usersSchema: CollectionSchema = {
  ...BASE_USERS_SCHEMA,
  columns: [
    ...(BASE_USERS_SCHEMA.columns ?? []),
    { name: 'bio', storage: 'text', interpretation: 'plain' },
  ],
}

async function makeContext(): Promise<RecordContext> {
  const sql = makeSql(new Database(':memory:'))
  ensureCollectionTable(sql, usersSchema)
  const registry = new SchemaRegistry([usersSchema])
  const ctx: RecordContext = {
    sql,
    schemaRegistry: registry,
    scopeId: 'app:app_01test',
    state: { getWebSockets: () => [] } as unknown as DurableObjectState,
    getPermissionContext: () => noopPermissionContext,
    send: () => {},
  }
  await registerUser(sql, 'u1', 'Ada', 'ada@example.com', undefined, false, 'member', registry)
  return ctx
}

/** A server action: app-level authorization already happened, RBAC is skipped. */
function serverActionUpdate(ctx: RecordContext, data: Record<string, unknown>): ToolResult {
  return putRecord(ctx, 'users', 'u1', data, 'u1', 'admin', true, false)
}

/** Assert the write was refused and hand back the message it refused with. */
function refusal(result: ToolResult, what: string): string {
  expect(result.success, `${what} should be refused`).toBe(false)
  if (result.success) throw new Error('unreachable')
  return result.error
}

describe('system-managed columns on users', () => {
  it('fails an attempted role change instead of reporting success', async () => {
    const ctx = await makeContext()

    const error = refusal(serverActionUpdate(ctx, { role: 'admin' }), 'role change')

    expect(error).toContain("'role' is system-managed")
    // The refusal has to carry the path that actually works.
    expect(error).toContain('tools.registerUser')
    expect(error).toContain('useUsers().setRole()')
    expect(getRecord(ctx.sql, 'users', 'u1', usersSchema)?.data.role).toBe('member')
  })

  it('fails every system-assigned column, not just role', async () => {
    const ctx = await makeContext()

    for (const [column, value] of [
      ['email', 'someone-else@example.com'],
      ['name', 'Not Ada'],
      ['imageUrl', 'https://example.com/a.png'],
    ] as const) {
      const error = refusal(serverActionUpdate(ctx, { [column]: value }), column)
      expect(error).toContain(`'${column}' is system-managed`)
    }

    expect(getRecord(ctx.sql, 'users', 'u1', usersSchema)?.data.email).toBe('ada@example.com')
  })

  it('silently preserves the system-maintained timestamps instead of refusing', async () => {
    const ctx = await makeContext()
    const before = getRecord(ctx.sql, 'users', 'u1', usersSchema)!.data

    // `lastSeenAt` is rewritten on every connect and every 60s heartbeat, and
    // neither path broadcasts. A client echoing the copy it holds is echoing a
    // value the server moved under it — not attempting a change.
    const result = serverActionUpdate(ctx, {
      createdAt: '2000-01-01T00:00:00.000Z',
      lastSeenAt: '2000-01-01T00:00:00.000Z',
      bio: 'Ships things',
    })

    expect(result).toMatchObject({ success: true })
    const saved = getRecord(ctx.sql, 'users', 'u1', usersSchema)!.data
    expect(saved.bio).toBe('Ships things')
    expect(saved.createdAt).toBe(before.createdAt)
    expect(saved.lastSeenAt).toBe(before.lastSeenAt)
  })

  it('accepts a whole-record round trip that leaves system columns unchanged', async () => {
    const ctx = await makeContext()
    const existing = getRecord(ctx.sql, 'users', 'u1', usersSchema)!.data

    // The common client shape: read the record, spread it, change one field.
    const result = serverActionUpdate(ctx, { ...existing, bio: 'Ships things' })

    expect(result).toMatchObject({ success: true })
    const saved = getRecord(ctx.sql, 'users', 'u1', usersSchema)!.data
    expect(saved.bio).toBe('Ships things')
    expect(saved.role).toBe('member')
    expect(saved.name).toBe('Ada')
  })

  it('treats absent, null and empty string as the one stored state they are', async () => {
    const ctx = await makeContext()

    // `imageUrl` was never set, so it reads back as absent. `coerceValue` maps
    // null and '' to the same NULL column, so none of these is a change.
    expect(serverActionUpdate(ctx, { imageUrl: null, bio: 'x' })).toMatchObject({ success: true })
    expect(serverActionUpdate(ctx, { imageUrl: '', bio: 'y' })).toMatchObject({ success: true })
  })

  it("accepts an echo of a '' system column the raw registerUser INSERT stored", async () => {
    const ctx = await makeContext()

    // registerUser's create branch is raw SQL, so a token-only connection
    // stores col_email = '' rather than NULL, and the record reads back as ''.
    await registerUser(ctx.sql, 'u2', 'Anonymous', '', undefined, false, 'member', ctx.schemaRegistry)
    expect(getRecord(ctx.sql, 'users', 'u2', usersSchema)!.data.email).toBe('')

    // A client holding that copy echoes it back. Nothing would be written.
    expect(
      putRecord(ctx, 'users', 'u2', { email: '', bio: 'x' }, 'u2', 'admin', true, false),
    ).toMatchObject({ success: true })

    // The first heartbeat rewrites the column through coerceValue, turning ''
    // into NULL. The client's pre-heartbeat copy must still round-trip.
    putRecord(ctx, 'users', 'u2', { email: '' }, 'u2', 'admin', true, true)
    expect(getRecord(ctx.sql, 'users', 'u2', usersSchema)!.data.email).toBeUndefined()
    expect(
      putRecord(ctx, 'users', 'u2', { email: '', bio: 'y' }, 'u2', 'admin', true, false),
    ).toMatchObject({ success: true })
  })

  describe('the create path', () => {
    it('refuses a supplied system column with wording a create can act on', async () => {
      const ctx = await makeContext()

      const error = refusal(
        putRecord(ctx, 'users', 'u-new', { name: 'Mallory' }, 'u-new', 'admin', true, false),
        'create with a system column',
      )

      expect(error).toContain("'name' is system-managed")
      expect(error).toContain('tools.registerUser')
      // There is no current value to re-send on a create; saying so would send
      // the caller looking for a value that does not exist.
      expect(error).not.toContain('Re-sending the current value')
      expect(getRecord(ctx.sql, 'users', 'u-new', usersSchema)).toBeNull()
    })

    it('still accepts a create that supplies no system column value', async () => {
      const ctx = await makeContext()

      const result = putRecord(
        ctx,
        'users',
        'u-new',
        { imageUrl: null, bio: 'x' },
        'u-new',
        'admin',
        true,
        false,
      )

      expect(result).toMatchObject({ success: true })
    })

    it('reports the missing create permission, not the field shape', async () => {
      const ctx = await makeContext()

      // Permission is the earlier question: a role that cannot create rows here
      // must hear that, rather than being told to fix a field it may not write
      // under any value. (BASE_USERS_SCHEMA gives '*' create: false.)
      const error = refusal(
        putRecord(ctx, 'users', 'u-new', { name: 'Mallory' }, 'u-new', 'member', false, false),
        'create without permission',
      )

      expect(error).toContain('CREATE DENIED')
    })
  })

  it('still lets a system update write system-managed columns', async () => {
    const ctx = await makeContext()

    // systemUpdate=true — the profile-sync path behind handleUserUpdate.
    const result = putRecord(ctx, 'users', 'u1', { name: 'Ada L.' }, 'u1', 'admin', true, true)

    expect(result).toMatchObject({ success: true })
    expect(getRecord(ctx.sql, 'users', 'u1', usersSchema)?.data.name).toBe('Ada L.')
  })
})
