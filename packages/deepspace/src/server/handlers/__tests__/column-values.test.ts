/**
 * What a column write actually stores, for the two cases where the value the
 * caller (or the schema) named was silently replaced by something else:
 *
 *  - a `timestampTrigger` on a `storage: 'number'` column wrote an ISO string,
 *    which `coerceValue` parsed into the *year*;
 *  - an empty string on a `storage: 'text'` column was folded into NULL, so a
 *    field written as `''` read back `undefined` and a `default: ''` never
 *    materialized at all.
 *
 * Both are silent — tsc, eslint and the schema lint are clean either way — so
 * they are locked down here against the real `putRecord` / `getRecord` pair.
 */

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { CollectionSchema } from '../../../shared/types'
import { getRecord, putRecord, type RecordContext } from '../records'
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

function makeContext(schemas: CollectionSchema[]): RecordContext {
  const sql = makeSql(new Database(':memory:'))
  for (const schema of schemas) ensureCollectionTable(sql, schema)
  return {
    sql,
    schemaRegistry: new SchemaRegistry(schemas),
    state: { getWebSockets: () => [] } as unknown as DurableObjectState,
    getPermissionContext: () => noopPermissionContext,
    send: () => {},
  }
}

const openPermissions = {
  '*': { read: true, create: true, update: true, delete: true },
} as CollectionSchema['permissions']

/** Two tickets collections that differ only in the trigger column's storage. */
function ticketsSchema(storage: 'number' | 'text'): CollectionSchema {
  return {
    name: `tickets_${storage}`,
    columns: [
      { name: 'status', storage: 'text', interpretation: 'plain' },
      {
        name: 'closedAt',
        storage,
        interpretation: { kind: 'datetime' },
        timestampTrigger: { field: 'status', value: 'closed' },
      },
    ],
    permissions: openPermissions,
  }
}

describe('timestampTrigger', () => {
  it('writes the representation the column declares, not an ISO string either way', () => {
    const numeric = ticketsSchema('number')
    const textual = ticketsSchema('text')
    const ctx = makeContext([numeric, textual])
    const before = Math.floor(Date.now() / 1000)

    for (const schema of [numeric, textual]) {
      expect(putRecord(ctx, schema.name, 'tk-1', { status: 'open' }, 'u1', 'admin')).toMatchObject({
        success: true,
      })
      expect(getRecord(ctx.sql, schema.name, 'tk-1', schema)?.data.closedAt).toBeUndefined()

      expect(
        putRecord(ctx, schema.name, 'tk-1', { status: 'closed' }, 'u1', 'admin'),
      ).toMatchObject({ success: true })
    }

    // A `number` column gets epoch seconds, the same unit an explicit ISO
    // datetime write uses. It used to get
    // `parseFloat('2026-08-18T…')` — the year, silently.
    const closedAt = getRecord(ctx.sql, numeric.name, 'tk-1', numeric)?.data.closedAt as number
    expect(typeof closedAt).toBe('number')
    expect(closedAt).toBeGreaterThanOrEqual(before)
    expect(closedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))

    const explicit = '2026-08-18T12:34:56.000Z'
    expect(
      putRecord(
        ctx,
        numeric.name,
        'tk-explicit',
        { status: 'open', closedAt: explicit },
        'u1',
        'admin',
      ),
    ).toMatchObject({ success: true })
    expect(getRecord(ctx.sql, numeric.name, 'tk-explicit', numeric)?.data.closedAt).toBe(
      Math.floor(new Date(explicit).getTime() / 1000),
    )

    // A `text` column still gets the ISO string.
    const closedAtText = getRecord(ctx.sql, textual.name, 'tk-1', textual)?.data.closedAt as string
    expect(typeof closedAtText).toBe('string')
    const closedAtTextMs = new Date(closedAtText).getTime()
    expect(closedAtTextMs).toBeGreaterThanOrEqual(before * 1000)
    expect(closedAtTextMs).toBeLessThanOrEqual(Date.now())
  })
})

const standups: CollectionSchema = {
  name: 'standups',
  columns: [
    { name: 'today', storage: 'text', interpretation: 'plain' },
    { name: 'blockers', storage: 'text', interpretation: 'plain', default: '' },
    { name: 'points', storage: 'number', interpretation: 'plain' },
  ],
  permissions: openPermissions,
}

describe('empty text values', () => {
  it('stores an empty string as itself, and materializes a `default` of one', () => {
    const ctx = makeContext([standups])

    // Written as '': reads back as '' — not absent. An action doing
    // `data.blockers.trim()` used to throw on the row it had just written.
    expect(
      putRecord(ctx, 'standups', 's1', { today: 'ship', blockers: '' }, 'u1', 'admin'),
    ).toMatchObject({ success: true })
    expect(getRecord(ctx.sql, 'standups', 's1', standups)?.data.blockers).toBe('')

    // Omitted on create: the column's `default: ''` is what the row holds.
    expect(putRecord(ctx, 'standups', 's2', { today: 'ship' }, 'u1', 'admin')).toMatchObject({
      success: true,
    })
    expect(getRecord(ctx.sql, 'standups', 's2', standups)?.data.blockers).toBe('')

    // A real value still replaces it, and clearing it back to '' sticks.
    putRecord(ctx, 'standups', 's2', { blockers: 'waiting on review' }, 'u1', 'admin')
    expect(getRecord(ctx.sql, 'standups', 's2', standups)?.data.blockers).toBe('waiting on review')
    putRecord(ctx, 'standups', 's2', { blockers: '' }, 'u1', 'admin')
    expect(getRecord(ctx.sql, 'standups', 's2', standups)?.data.blockers).toBe('')
  })

  it('keeps a numeric column NULL for an empty string — there is nothing to store', () => {
    const ctx = makeContext([standups])

    putRecord(ctx, 'standups', 's3', { today: 'ship', points: '' }, 'u1', 'admin')
    expect(getRecord(ctx.sql, 'standups', 's3', standups)?.data.points).toBeUndefined()
  })
})
