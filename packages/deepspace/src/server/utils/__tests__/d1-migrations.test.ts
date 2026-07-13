import { describe, it, expect } from 'vitest'
import { runMigrations } from '../d1-migrations'

/**
 * In-memory fake D1 sufficient for runMigrations' surface area.
 * Implements just the slice the runner touches:
 *   - prepare(sql).run()    — bootstrap, individual user statements,
 *                             insert into meta-table
 *   - prepare(sql).first()  — read the COUNT(*) of applied rows
 *   - prepare(sql).bind(...).run() — parameterized insert
 *
 * Sentinel: any statement starting with `FAIL` throws.
 */
function fakeD1() {
  let appliedRows = 0
  const ranStatements: string[] = []
  const insertedIndices: number[] = []
  let metaTableCreated = false

  return {
    db: {
      prepare(sql: string) {
        const trimmed = sql.trim().replace(/\s+/g, ' ')

        // Bootstrap statement — single line CREATE TABLE
        if (trimmed.startsWith('CREATE TABLE IF NOT EXISTS _dpc_migrations')) {
          return {
            async run() {
              metaTableCreated = true
              return { success: true }
            },
          }
        }

        // Read the applied-row count
        if (trimmed === 'SELECT COUNT(*) AS n FROM _dpc_migrations') {
          return {
            async first<T>(): Promise<T | null> {
              if (!metaTableCreated) throw new Error('fake D1: meta table not created yet')
              return { n: appliedRows } as T
            },
          }
        }

        // Insert into meta-table — bound; bind returns an inner statement
        if (trimmed.startsWith('INSERT INTO _dpc_migrations')) {
          let bound: unknown[] = []
          return {
            bind(...args: unknown[]) {
              bound = args
              return {
                async run() {
                  const idx = bound[0] as number
                  insertedIndices.push(idx)
                  appliedRows = Math.max(appliedRows, idx + 1)
                  return { success: true }
                },
              }
            },
          }
        }

        // Sentinel for tests that exercise the failure path
        if (trimmed.startsWith('FAIL')) {
          return {
            async run(): Promise<never> {
              throw new Error('intentional fail')
            },
          }
        }

        // Anything else — record + return success
        return {
          async run() {
            ranStatements.push(trimmed)
            return { success: true }
          },
        }
      },
    } as unknown as D1Database,
    getVersion: () => appliedRows,
    getRanStatements: () => ranStatements,
    getInsertedIndices: () => insertedIndices,
    setVersion: (v: number) => { appliedRows = v; metaTableCreated = true },
    isMetaTableCreated: () => metaTableCreated,
  }
}

describe('runMigrations', () => {
  it('runs all migrations on a fresh DB', async () => {
    const f = fakeD1()
    const result = await runMigrations(f.db, [
      'CREATE TABLE a (id INTEGER)',
      'CREATE TABLE b (id INTEGER)',
    ])
    expect(result).toEqual({ fromVersion: 0, toVersion: 2, applied: 2 })
    expect(f.getRanStatements()).toEqual(['CREATE TABLE a (id INTEGER)', 'CREATE TABLE b (id INTEGER)'])
    expect(f.getVersion()).toBe(2)
    expect(f.isMetaTableCreated()).toBe(true)
  })

  it('is a no-op when DB is already up to date', async () => {
    const f = fakeD1()
    f.setVersion(2)
    const result = await runMigrations(f.db, [
      'CREATE TABLE a (id INTEGER)',
      'CREATE TABLE b (id INTEGER)',
    ])
    expect(result).toEqual({ fromVersion: 2, toVersion: 2, applied: 0 })
    expect(f.getRanStatements()).toEqual([])
  })

  it('only applies new migrations when the array grows', async () => {
    const f = fakeD1()
    f.setVersion(1)
    const result = await runMigrations(f.db, [
      'CREATE TABLE a (id INTEGER)',
      'CREATE TABLE b (id INTEGER)',
      'CREATE TABLE c (id INTEGER)',
    ])
    expect(result).toEqual({ fromVersion: 1, toVersion: 3, applied: 2 })
    expect(f.getRanStatements()).toEqual([
      'CREATE TABLE b (id INTEGER)',
      'CREATE TABLE c (id INTEGER)',
    ])
    expect(f.getVersion()).toBe(3)
  })

  it('handles an empty migration list', async () => {
    const f = fakeD1()
    const result = await runMigrations(f.db, [])
    expect(result).toEqual({ fromVersion: 0, toVersion: 0, applied: 0 })
    expect(f.getRanStatements()).toEqual([])
  })

  it('splits multi-statement migrations on ;', async () => {
    const f = fakeD1()
    const result = await runMigrations(f.db, [
      `CREATE TABLE cards (id INTEGER PRIMARY KEY, name TEXT);
       CREATE INDEX idx_cards_name ON cards(name);
       CREATE INDEX idx_cards_id ON cards(id);`,
    ])
    expect(result.applied).toBe(1)
    // 3 statements should be split out, all run individually, none exec()'d together
    expect(f.getRanStatements()).toEqual([
      'CREATE TABLE cards (id INTEGER PRIMARY KEY, name TEXT)',
      'CREATE INDEX idx_cards_name ON cards(name)',
      'CREATE INDEX idx_cards_id ON cards(id)',
    ])
  })

  it('throws on a failing statement without advancing version', async () => {
    const f = fakeD1()
    await expect(
      runMigrations(f.db, [
        'CREATE TABLE a (id INTEGER)',
        'FAIL this one breaks',
        'CREATE TABLE c (id INTEGER)',
      ]),
    ).rejects.toThrow(/Migration 1 failed.*intentional fail/)
    // First migration succeeded → version advanced to 1; failure aborted before 2.
    expect(f.getVersion()).toBe(1)
    expect(f.getRanStatements()).toEqual(['CREATE TABLE a (id INTEGER)'])
  })

  it('failure includes the current version in the message', async () => {
    const f = fakeD1()
    f.setVersion(5)
    await expect(
      runMigrations(f.db, [
        ...Array(5).fill('CREATE TABLE x (id INTEGER)'),
        'FAIL break-me',
      ]),
    ).rejects.toThrow(/db at version=5/)
  })

  it('trims whitespace + skips empty statements after split', async () => {
    const f = fakeD1()
    const result = await runMigrations(f.db, [
      // Trailing semicolon, blank lines, indented — all common from heredoc-style migrations
      `
        CREATE TABLE a (id INTEGER);

        CREATE TABLE b (id INTEGER);
      `,
    ])
    expect(result.applied).toBe(1)
    expect(f.getRanStatements()).toEqual([
      'CREATE TABLE a (id INTEGER)',
      'CREATE TABLE b (id INTEGER)',
    ])
  })
})
