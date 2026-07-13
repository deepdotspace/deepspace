/**
 * Migration tests for ensureCollectionTable.
 *
 * The Cloudflare DO's SqlStorage is stubbed by better-sqlite3 — both speak
 * SQLite and the small surface we use (`exec(query, ...bindings)` returning
 * a cursor with `.toArray()`) is trivial to bridge. The aim is to lock down
 * the additive-migration story we rely on for production deploys:
 *
 *   1. Cold start, no table     → CREATE TABLE with all schema columns.
 *   2. Schema gains a column    → ALTER TABLE ADD COLUMN, existing rows
 *                                  survive with NULL on the new column.
 *   3. Re-running same schema   → no-op (idempotent).
 *   4. uniqueOn                 → UNIQUE INDEX created.
 *   5. Expression columns       → not materialized as storage columns.
 *
 * If any of these break, the production migration story breaks: a deploy
 * that adds a column will silently leave existing DOs missing it until
 * something else triggers schema-resync.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureCollectionTable,
  type MigrationLogger,
} from '../collection-table-migration'
import type { CollectionSchema, ColumnDefinition } from '../../schemas/registry'

// ---------------------------------------------------------------------------
// SqlStorage shim over better-sqlite3
// ---------------------------------------------------------------------------

function makeSql(db: Database.Database): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]): { toArray: () => unknown[] } {
      // The DO's SqlStorage interprets multi-statement strings, parameterized
      // single statements, and statements with no bindings. better-sqlite3
      // handles each case slightly differently:
      //   - Multi-statement (e.g. CREATE TABLE with embedded comments) → exec
      //   - Parameterized → prepare().all()/run()
      const trimmed = query.trim()
      const isSelect = /^(SELECT|PRAGMA)/i.test(trimmed)

      if (bindings.length === 0 && !isSelect) {
        db.exec(query)
        return { toArray: () => [] }
      }

      const stmt = db.prepare(query)
      if (isSelect) {
        const rows = stmt.all(...bindings)
        return { toArray: () => rows }
      }
      stmt.run(...bindings)
      return { toArray: () => [] }
    },
    get databaseSize(): number {
      return 0
    },
    Cursor: undefined as unknown as SqlStorage['Cursor'],
    Statement: undefined as unknown as SqlStorage['Statement'],
  } as unknown as SqlStorage
}

function tableInfo(db: Database.Database, table: string): Array<{ name: string; type: string }> {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((r) => r as { name: string; type: string })
    .map((r) => ({ name: r.name, type: r.type }))
}

function indexNames(db: Database.Database, table: string): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`)
    .all(table)
    .map((r) => (r as { name: string }).name)
}

const collectingLogger = (): { warnings: string[] } & MigrationLogger => {
  const warnings: string[] = []
  return { warnings, warn: (msg) => warnings.push(msg) }
}

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

const messagesV1: CollectionSchema = {
  name: 'messages',
  columns: [
    { name: 'channelId', storage: 'text', interpretation: 'plain' },
    { name: 'content', storage: 'text', interpretation: 'plain' },
    { name: 'authorId', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: true, create: true, update: 'own', delete: 'own' },
    viewer: { read: false, create: false, update: false, delete: false },
  },
}

const messagesV2: CollectionSchema = {
  ...messagesV1,
  columns: [
    ...messagesV1.columns!,
    { name: 'deleted', storage: 'number', interpretation: { kind: 'boolean' } },
  ],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureCollectionTable', () => {
  let db: Database.Database
  let sql: SqlStorage

  beforeEach(() => {
    db = new Database(':memory:')
    sql = makeSql(db)
  })

  describe('cold start (no table)', () => {
    it('creates the table with system + schema columns', () => {
      ensureCollectionTable(sql, messagesV1)

      const cols = tableInfo(db, 'c_messages').map((c) => c.name).sort()
      expect(cols).toEqual([
        '_created_at',
        '_created_by',
        '_row_id',
        '_updated_at',
        'col_authorid',
        'col_channelid',
        'col_content',
      ])
    })

    it('uses REAL for number-storage columns and TEXT for text', () => {
      ensureCollectionTable(sql, messagesV2)
      const cols = tableInfo(db, 'c_messages')
      expect(cols.find((c) => c.name === 'col_content')?.type).toBe('TEXT')
      expect(cols.find((c) => c.name === 'col_deleted')?.type).toBe('REAL')
    })
  })

  describe('schema upgrade (table exists, new column)', () => {
    it('runs ALTER TABLE ADD COLUMN for the new column', () => {
      ensureCollectionTable(sql, messagesV1)
      expect(tableInfo(db, 'c_messages').map((c) => c.name)).not.toContain('col_deleted')

      ensureCollectionTable(sql, messagesV2)
      expect(tableInfo(db, 'c_messages').map((c) => c.name)).toContain('col_deleted')
    })

    it('preserves existing rows; new column is NULL on them', () => {
      ensureCollectionTable(sql, messagesV1)
      db.prepare(
        `INSERT INTO c_messages (_row_id, _created_by, _created_at, _updated_at, col_channelid, col_content, col_authorid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('msg-1', 'u-1', '2026-01-01', '2026-01-01', 'general', 'hello', 'u-1')

      ensureCollectionTable(sql, messagesV2)

      const row = db.prepare(`SELECT * FROM c_messages WHERE _row_id = ?`).get('msg-1') as Record<string, unknown>
      expect(row.col_content).toBe('hello')
      expect(row.col_deleted).toBeNull()
    })

    it('is idempotent: running v2 migration twice does not throw', () => {
      ensureCollectionTable(sql, messagesV1)
      ensureCollectionTable(sql, messagesV2)
      expect(() => ensureCollectionTable(sql, messagesV2)).not.toThrow()
    })
  })

  describe('uniqueOn', () => {
    it('creates a UNIQUE INDEX over the named columns', () => {
      const channelMembers: CollectionSchema = {
        name: 'channel-members',
        columns: [
          { name: 'channelId', storage: 'text', interpretation: 'plain' },
          { name: 'userId', storage: 'text', interpretation: 'plain' },
          { name: 'joinedAt', storage: 'text', interpretation: { kind: 'datetime' } },
        ],
        uniqueOn: ['channelId', 'userId'],
        permissions: {
          admin: { read: true, create: true, update: false, delete: true },
          member: { read: true, create: true, update: false, delete: 'own' },
          viewer: { read: true, create: false, update: false, delete: false },
        },
      }

      ensureCollectionTable(sql, channelMembers)
      // Hyphens in collection name are normalized in the table name.
      const tbl = 'c_channel_members'
      expect(indexNames(db, tbl)).toContain(
        `uniq_${tbl}_channelId_userId`,
      )

      // The index actually enforces uniqueness:
      db.prepare(
        `INSERT INTO ${tbl} (_row_id, _created_by, _created_at, _updated_at, col_channelid, col_userid, col_joinedat) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('a', 'u', 'now', 'now', 'c1', 'u1', 'now')
      expect(() =>
        db
          .prepare(
            `INSERT INTO ${tbl} (_row_id, _created_by, _created_at, _updated_at, col_channelid, col_userid, col_joinedat) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('b', 'u', 'now', 'now', 'c1', 'u1', 'now'),
      ).toThrow(/UNIQUE/i)
    })

    it('warns (not throws) when an index cannot be created — pre-existing duplicate rows', () => {
      const channelMembers: CollectionSchema = {
        name: 'channel-members',
        columns: [
          { name: 'channelId', storage: 'text', interpretation: 'plain' },
          { name: 'userId', storage: 'text', interpretation: 'plain' },
        ],
        uniqueOn: ['channelId', 'userId'],
        permissions: {
          admin: { read: true, create: true, update: false, delete: true },
          member: { read: true, create: true, update: false, delete: 'own' },
          viewer: { read: true, create: false, update: false, delete: false },
        },
      }
      // First create the table without the unique constraint by giving it
      // a schema that doesn't have uniqueOn yet.
      ensureCollectionTable(sql, { ...channelMembers, uniqueOn: undefined })
      const tbl = 'c_channel_members'
      // Insert duplicate rows.
      const insert = (id: string) =>
        db
          .prepare(
            `INSERT INTO ${tbl} (_row_id, _created_by, _created_at, _updated_at, col_channelid, col_userid) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, 'u', 'now', 'now', 'c1', 'u1')
      insert('row-a')
      insert('row-b')

      // Now upgrade to schema with uniqueOn — the index should fail to
      // create, ensureCollectionTable should swallow + log it.
      const log = collectingLogger()
      expect(() => ensureCollectionTable(sql, channelMembers, log)).not.toThrow()
      expect(log.warnings.join('\n')).toMatch(/Cannot create UNIQUE index/)
      expect(indexNames(db, tbl)).not.toContain(`uniq_${tbl}_channelId_userId`)
    })
  })

  describe('computed columns', () => {
    it('skips expression-backed columns when creating the table', () => {
      const computed: CollectionSchema = {
        name: 'derived',
        columns: [
          { name: 'rawValue', storage: 'number', interpretation: 'plain' },
          {
            name: 'doubled',
            storage: 'number',
            interpretation: 'plain',
            // The migration treats any column with `expression` set as
            // computed and does not create a storage column for it.
            expression: 'col_rawvalue * 2',
          } as ColumnDefinition & { expression: string },
        ],
        permissions: {
          admin: { read: true, create: true, update: true, delete: true },
          member: { read: true, create: false, update: false, delete: false },
          viewer: { read: true, create: false, update: false, delete: false },
        },
      }
      ensureCollectionTable(sql, computed)
      const cols = tableInfo(db, 'c_derived').map((c) => c.name)
      expect(cols).toContain('col_rawvalue')
      expect(cols).not.toContain('col_doubled')
    })
  })
})
