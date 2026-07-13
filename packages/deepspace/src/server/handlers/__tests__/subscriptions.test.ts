/**
 * Tests for `executeQuery`'s `skipUserRbac` parameter.
 *
 * `tools.query` from a server action (the X-App-Action path) needs to bypass
 * the caller's RBAC for parity with `tools.get / create / update / remove`.
 * `skipUserRbac` toggles this. These tests lock the contract down so a future
 * edit can't silently re-enable RBAC on the action path (or break it for
 * normal user subscriptions).
 *
 * Setup mirrors `collection-table-migration.test.ts`: an in-memory
 * better-sqlite3 instance fronted by a small `SqlStorage` shim. We register a
 * schema, run `ensureCollectionTable` to materialise the c_* table, insert
 * fixtures by hand, and then call `executeQuery` directly.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { executeQuery, type SubscriptionContext } from '../subscriptions'
import {
  SchemaRegistry,
  noopPermissionContext,
  columnId,
  type CollectionSchema,
} from '../../schemas/registry'
import { ensureCollectionTable } from '../../rooms/collection-table-migration'

// ---------------------------------------------------------------------------
// Test infra
// ---------------------------------------------------------------------------

interface SpiedSql {
  sql: SqlStorage
  /** All `exec()` calls in order, including the rendered query string. */
  queries: { query: string; bindings: unknown[] }[]
}

function makeSql(db: Database.Database, spy?: { queries: SpiedSql['queries'] }): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]): { toArray: () => unknown[] } {
      spy?.queries.push({ query, bindings })
      const trimmed = query.trim()
      const isSelect = /^(SELECT|PRAGMA)/i.test(trimmed)
      if (bindings.length === 0 && !isSelect) {
        db.exec(query)
        return { toArray: () => [] }
      }
      const stmt = db.prepare(query)
      if (isSelect) {
        return { toArray: () => stmt.all(...bindings) }
      }
      stmt.run(...bindings)
      return { toArray: () => [] }
    },
    get databaseSize(): number { return 0 },
    Cursor: undefined as unknown as SqlStorage['Cursor'],
    Statement: undefined as unknown as SqlStorage['Statement'],
  } as unknown as SqlStorage
}

function makeSqlSpy(db: Database.Database): SpiedSql {
  const queries: SpiedSql['queries'] = []
  const sql = makeSql(db, { queries })
  return { sql, queries }
}

function makeContext(
  db: Database.Database,
  schemas: CollectionSchema[],
  spy?: SpiedSql,
): SubscriptionContext {
  return {
    sql: spy?.sql ?? makeSql(db),
    schemaRegistry: new SchemaRegistry(schemas),
    state: {} as DurableObjectState,
    getPermissionContext: () => noopPermissionContext,
    send: () => {},
  }
}

/**
 * Find the SELECT statement issued against a given table. There may be
 * other SELECTs in a single executeQuery call (e.g. `team_members` lookup
 * during pushdown) — this returns the one that targets the requested table.
 */
function findSelectFor(spy: SpiedSql, tableName: string): { query: string; bindings: unknown[] } {
  const match = spy.queries.find(
    q => /^\s*SELECT/i.test(q.query) && q.query.includes(`"${tableName}"`),
  )
  if (!match) throw new Error(`no SELECT against ${tableName} in spy.queries`)
  return match
}

/**
 * Insert a row into a c_* table by hand. `cols` keys are the schema column
 * names (camelCase); they're translated to `col_<id>` via `columnId`.
 */
function insert(
  db: Database.Database,
  tableName: string,
  row: { recordId: string; createdBy: string; cols?: Record<string, unknown> },
) {
  const ts = '2026-05-06T00:00:00.000Z'
  const cols = row.cols ?? {}
  const names = Object.keys(cols)
  const colCols = names.map(c => `"${columnId(c)}"`).join(',')
  const colVals = names.map(() => '?').join(',')
  const sql =
    `INSERT INTO ${tableName} ` +
    `(_row_id, _created_by, _created_at, _updated_at${names.length ? ',' + colCols : ''}) ` +
    `VALUES (?, ?, ?, ?${names.length ? ',' + colVals : ''})`
  db.prepare(sql).run(row.recordId, row.createdBy, ts, ts, ...Object.values(cols))
}

// ---------------------------------------------------------------------------
// read: 'own'
// ---------------------------------------------------------------------------

describe("executeQuery with read: 'own'", () => {
  const schema: CollectionSchema = {
    name: 'roles',
    columns: [
      { name: 'gameId', storage: 'text', interpretation: 'plain' },
      { name: 'role',   storage: 'text', interpretation: 'plain' },
    ],
    permissions: {
      member: { read: 'own', create: true, update: 'own', delete: 'own' },
    },
  }

  let db: Database.Database
  let ctx: SubscriptionContext

  beforeEach(() => {
    db = new Database(':memory:')
    ctx = makeContext(db, [schema])
    ensureCollectionTable(ctx.sql, schema)
    insert(db, 'c_roles', { recordId: 'r1', createdBy: 'alice', cols: { gameId: 'g1', role: 'wolf' } })
    insert(db, 'c_roles', { recordId: 'r2', createdBy: 'bob',   cols: { gameId: 'g1', role: 'villager' } })
  })

  it('default behavior: caller sees only their own row', () => {
    const records = executeQuery(ctx, { collection: 'roles' }, 'alice', 'member')
    expect(records.map(r => r.recordId)).toEqual(['r1'])
  })

  it('omitting skipUserRbac matches passing false (backward compat)', () => {
    const omitted = executeQuery(ctx, { collection: 'roles' }, 'alice', 'member')
    const explicit = executeQuery(ctx, { collection: 'roles' }, 'alice', 'member', false)
    expect(omitted.map(r => r.recordId)).toEqual(explicit.map(r => r.recordId))
  })

  it('skipUserRbac=true: caller sees all rows regardless of owner', () => {
    const records = executeQuery(ctx, { collection: 'roles' }, 'alice', 'member', true)
    expect(records.map(r => r.recordId).sort()).toEqual(['r1', 'r2'])
  })

  it('user-supplied where filters still apply alongside skipUserRbac', () => {
    insert(db, 'c_roles', { recordId: 'r3', createdBy: 'carol', cols: { gameId: 'g2', role: 'seer' } })

    const records = executeQuery(
      ctx,
      { collection: 'roles', where: { gameId: 'g1' } },
      'alice', 'member', true,
    )
    expect(records.map(r => r.recordId).sort()).toEqual(['r1', 'r2'])
  })

  it('where: { recordId } filters to the single row (envelope-field lookup)', () => {
    // Bob owns r2 — make sure RBAC is bypassed for this check.
    const records = executeQuery(
      ctx,
      { collection: 'roles', where: { recordId: 'r2' } },
      'alice', 'member', true,
    )
    expect(records.map(r => r.recordId)).toEqual(['r2'])
  })
})

// ---------------------------------------------------------------------------
// read: 'team' — confirms the SQL pushdown path is also bypassed
// ---------------------------------------------------------------------------

describe("executeQuery with read: 'team'", () => {
  const teamMembersSchema: CollectionSchema = {
    name: 'team_members',
    columns: [
      { name: 'userId', storage: 'text', interpretation: 'plain' },
      { name: 'teamId', storage: 'text', interpretation: 'plain' },
      { name: 'status', storage: 'text', interpretation: 'plain' },
    ],
    permissions: {
      member: { read: true, create: true, update: true, delete: true },
    },
  }

  const docsSchema: CollectionSchema = {
    name: 'docs',
    columns: [
      { name: 'teamId', storage: 'text', interpretation: 'plain' },
      { name: 'title',  storage: 'text', interpretation: 'plain' },
    ],
    teamField: 'teamId',
    permissions: {
      member: { read: 'team', create: true, update: 'team', delete: 'team' },
    },
  }

  let db: Database.Database
  let ctx: SubscriptionContext

  beforeEach(() => {
    db = new Database(':memory:')
    ctx = makeContext(db, [teamMembersSchema, docsSchema])
    ensureCollectionTable(ctx.sql, teamMembersSchema)
    ensureCollectionTable(ctx.sql, docsSchema)

    // Alice is on team_x; nobody is on team_y
    insert(db, 'c_team_members', {
      recordId: 'tm1',
      createdBy: 'alice',
      cols: { userId: 'alice', teamId: 'team_x', status: 'active' },
    })

    // Two docs: one in team_x (Alice's team), one in team_y (not Alice's)
    insert(db, 'c_docs', { recordId: 'd1', createdBy: 'alice', cols: { teamId: 'team_x', title: 'Mine' } })
    insert(db, 'c_docs', { recordId: 'd2', createdBy: 'bob',   cols: { teamId: 'team_y', title: 'Theirs' } })
  })

  it('default behavior: SQL pushdown filters to caller\'s teams', () => {
    const records = executeQuery(ctx, { collection: 'docs' }, 'alice', 'member')
    expect(records.map(r => r.recordId)).toEqual(['d1'])
  })

  it('skipUserRbac=true: pushdown is skipped, all teams returned', () => {
    const records = executeQuery(ctx, { collection: 'docs' }, 'alice', 'member', true)
    expect(records.map(r => r.recordId).sort()).toEqual(['d1', 'd2'])
  })

  // ---- SQL-level proof: confirm the team filter actually lives in the SQL,
  // not in JS. The behavioral tests above only check the final result; these
  // assert the SQL string was constructed (or not) the way we expect, so a
  // future edit can't accidentally move the filter into JS post-fetch.

  it('default behavior: SQL contains the team IN (...) clause (filter at DB)', () => {
    const spy = makeSqlSpy(db)
    const spiedCtx = makeContext(db, [teamMembersSchema, docsSchema], spy)

    executeQuery(spiedCtx, { collection: 'docs' }, 'alice', 'member')

    const docsSelect = findSelectFor(spy, 'c_docs')
    // Team filter present in the WHERE
    expect(docsSelect.query).toMatch(/IN\s*\(\?\)/)
    expect(docsSelect.bindings).toContain('team_x')
    // OR _created_by = ? sentinel for self-created rows
    expect(docsSelect.query).toMatch(/_created_by\s*=\s*\?/)
    expect(docsSelect.bindings).toContain('alice')
    // team_y must never appear in any binding to this query
    expect(docsSelect.bindings).not.toContain('team_y')
  })

  it('skipUserRbac=true: SQL has no team filter (pushdown bypassed)', () => {
    const spy = makeSqlSpy(db)
    const spiedCtx = makeContext(db, [teamMembersSchema, docsSchema], spy)

    executeQuery(spiedCtx, { collection: 'docs' }, 'alice', 'member', true)

    const docsSelect = findSelectFor(spy, 'c_docs')
    // No team IN filter, no created_by sentinel
    expect(docsSelect.query).not.toMatch(/IN\s*\(\?\)/)
    expect(docsSelect.query).not.toMatch(/_created_by\s*=\s*\?/)
    expect(docsSelect.bindings).not.toContain('team_x')
    expect(docsSelect.bindings).not.toContain('alice')
  })
})

// ---------------------------------------------------------------------------
// read: false — confirms a fully-denied role can still be bypassed by an action
// ---------------------------------------------------------------------------

describe("executeQuery with read: false", () => {
  const schema: CollectionSchema = {
    name: 'secrets',
    columns: [{ name: 'value', storage: 'text', interpretation: 'plain' }],
    permissions: {
      viewer: { read: false, create: false, update: false, delete: false },
    },
  }

  let db: Database.Database
  let ctx: SubscriptionContext

  beforeEach(() => {
    db = new Database(':memory:')
    ctx = makeContext(db, [schema])
    ensureCollectionTable(ctx.sql, schema)
    insert(db, 'c_secrets', { recordId: 's1', createdBy: 'admin', cols: { value: 'hidden' } })
  })

  it('default behavior: viewer reads nothing', () => {
    const records = executeQuery(ctx, { collection: 'secrets' }, 'alice', 'viewer')
    expect(records).toEqual([])
  })

  it('skipUserRbac=true: action sees the row even with read: false', () => {
    const records = executeQuery(ctx, { collection: 'secrets' }, 'alice', 'viewer', true)
    expect(records.map(r => r.recordId)).toEqual(['s1'])
  })
})

// ---------------------------------------------------------------------------
// read: true — regression: bypass shouldn't change anything for open reads
// ---------------------------------------------------------------------------

describe("executeQuery with read: true (regression)", () => {
  const schema: CollectionSchema = {
    name: 'public_announcements',
    columns: [{ name: 'msg', storage: 'text', interpretation: 'plain' }],
    permissions: {
      member: { read: true, create: true, update: 'own', delete: 'own' },
    },
  }

  let db: Database.Database
  let ctx: SubscriptionContext

  beforeEach(() => {
    db = new Database(':memory:')
    ctx = makeContext(db, [schema])
    ensureCollectionTable(ctx.sql, schema)
    insert(db, 'c_public_announcements', { recordId: 'a1', createdBy: 'alice', cols: { msg: 'hi' } })
    insert(db, 'c_public_announcements', { recordId: 'a2', createdBy: 'bob',   cols: { msg: 'hello' } })
  })

  it('returns all rows under default RBAC', () => {
    const records = executeQuery(ctx, { collection: 'public_announcements' }, 'carol', 'member')
    expect(records.map(r => r.recordId).sort()).toEqual(['a1', 'a2'])
  })

  it('returns identical rows with skipUserRbac=true (no regression)', () => {
    const records = executeQuery(ctx, { collection: 'public_announcements' }, 'carol', 'member', true)
    expect(records.map(r => r.recordId).sort()).toEqual(['a1', 'a2'])
  })
})
