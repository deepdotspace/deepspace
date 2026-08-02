import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { CollectionSchema } from '../../schemas/registry'
import { ensureCollectionTable } from '../collection-table-migration'
import { RecordRoom } from '../record-room'
;(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair ??= class {
  constructor(_req: string, _resp: string) {}
}

function makeSql(db: Database.Database): SqlStorage {
  return {
    exec(query: string, ...bindings: unknown[]): { toArray: () => unknown[] } {
      const trimmed = query.trim()
      const isSelect = /^(SELECT|PRAGMA)/i.test(trimmed)

      if (bindings.length === 0 && !isSelect) {
        db.exec(query)
        return { toArray: () => [] }
      }

      const statement = db.prepare(query)
      if (isSelect) {
        return { toArray: () => statement.all(...bindings) }
      }
      statement.run(...bindings)
      return { toArray: () => [] }
    },
    get databaseSize(): number {
      return 0
    },
  } as unknown as SqlStorage
}

function makeState(db: Database.Database): DurableObjectState {
  return {
    storage: {
      sql: makeSql(db),
      setAlarm() {},
      transactionSync<T>(closure: () => T): T {
        return db.transaction(closure)()
      },
    },
    setWebSocketAutoResponse() {},
    getWebSockets(): WebSocket[] {
      return []
    },
    acceptWebSocket() {},
  } as unknown as DurableObjectState
}

const notesSchema: CollectionSchema = {
  name: 'notes',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain' },
    { name: 'slug', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    '*': { read: true, create: true, update: true, delete: true },
  },
}

function createLegacyTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE records (
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
}

function insertLegacy(
  db: Database.Database,
  record: { collection?: string; id: string; data: string },
): void {
  db.prepare(
    `INSERT INTO records (collection, record_id, data, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    record.collection ?? 'notes',
    record.id,
    record.data,
    'user-1',
    '2026-01-01T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
  )
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  )
}

async function initialize(room: RecordRoom): Promise<void> {
  const response = await room.fetch(new Request('https://room.invalid/initialize'))
  expect(response.status).toBe(404)
}

describe('RecordRoom legacy records migration', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createLegacyTable(db)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  it('moves every row and removes the legacy table only after all inserts succeed', async () => {
    insertLegacy(db, { id: 'note-1', data: JSON.stringify({ title: 'First' }) })
    insertLegacy(db, { id: 'note-2', data: JSON.stringify({ title: 'Second' }) })

    await initialize(new RecordRoom(makeState(db), {}, [notesSchema]))

    expect(tableExists(db, 'records')).toBe(false)
    expect(db.prepare(`SELECT _row_id, col_title FROM c_notes ORDER BY _row_id`).all()).toEqual([
      { _row_id: 'note-1', col_title: 'First' },
      { _row_id: 'note-2', col_title: 'Second' },
    ])
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Migrated 2 records from document-mode'),
    )
  })

  it('retains every source row and writes nothing when a collection schema is missing', async () => {
    insertLegacy(db, { id: 'note-1', data: JSON.stringify({ title: 'Valid' }) })
    insertLegacy(db, {
      collection: 'removed-collection',
      id: 'unknown-1',
      data: JSON.stringify({ title: 'Unknown' }),
    })

    await initialize(new RecordRoom(makeState(db), {}, [notesSchema]))

    expect(tableExists(db, 'records')).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM records`).get()).toEqual({ count: 2 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM c_notes`).get()).toEqual({ count: 0 })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('1 missing schema'))
  })

  it('retains every source row on malformed JSON and retries cleanly after repair', async () => {
    insertLegacy(db, { id: 'note-1', data: JSON.stringify({ title: 'Valid' }) })
    insertLegacy(db, { id: 'note-bad', data: '{"title":' })

    await initialize(new RecordRoom(makeState(db), {}, [notesSchema]))

    expect(tableExists(db, 'records')).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM records`).get()).toEqual({ count: 2 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM c_notes`).get()).toEqual({ count: 0 })
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('1 invalid data'))

    db.prepare(`UPDATE records SET data = ? WHERE record_id = ?`).run(
      JSON.stringify({ title: 'Repaired' }),
      'note-bad',
    )
    await initialize(new RecordRoom(makeState(db), {}, [notesSchema]))

    expect(tableExists(db, 'records')).toBe(false)
    expect(db.prepare(`SELECT _row_id FROM c_notes ORDER BY _row_id`).all()).toEqual([
      { _row_id: 'note-1' },
      { _row_id: 'note-bad' },
    ])
  })

  it('retains every source row and writes nothing when a target record already exists', async () => {
    ensureCollectionTable(makeSql(db), notesSchema)
    db.prepare(
      `INSERT INTO c_notes (_row_id, _created_by, _created_at, _updated_at, col_title)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('note-conflict', 'user-2', 'now', 'now', 'Current value')
    insertLegacy(db, {
      id: 'note-conflict',
      data: JSON.stringify({ title: 'Legacy value' }),
    })
    insertLegacy(db, { id: 'note-new', data: JSON.stringify({ title: 'New value' }) })

    await initialize(new RecordRoom(makeState(db), {}, [notesSchema]))

    expect(tableExists(db, 'records')).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM records`).get()).toEqual({ count: 2 })
    expect(db.prepare(`SELECT _row_id, col_title FROM c_notes`).all()).toEqual([
      { _row_id: 'note-conflict', col_title: 'Current value' },
    ])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('1 target conflict'))
  })

  it('rolls back target inserts and retains the source table when an insert fails', async () => {
    const uniqueNotesSchema: CollectionSchema = {
      ...notesSchema,
      uniqueOn: ['slug'],
    }
    insertLegacy(db, { id: 'note-1', data: JSON.stringify({ title: 'First', slug: 'duplicate' }) })
    insertLegacy(db, { id: 'note-2', data: JSON.stringify({ title: 'Second', slug: 'duplicate' }) })

    await initialize(new RecordRoom(makeState(db), {}, [uniqueNotesSchema]))

    expect(tableExists(db, 'records')).toBe(true)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM records`).get()).toEqual({ count: 2 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM c_notes`).get()).toEqual({ count: 0 })
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('no records migrated and the records table was retained for retry'),
      expect.anything(),
    )
  })
})
