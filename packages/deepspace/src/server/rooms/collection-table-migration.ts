/**
 * Per-collection SQLite table management.
 *
 * Pure functions over the DO's SqlStorage. Extracted from RecordRoom so the
 * CREATE / ALTER / unique-index paths are testable without spinning up a
 * full DurableObject in miniflare.
 *
 * Behavior:
 *   - If the table doesn't exist: CREATE with the system columns + every
 *     resolved schema column.
 *   - If the table exists: PRAGMA table_info, ALTER TABLE ADD COLUMN for any
 *     resolved schema columns missing from the table. Idempotent — re-running
 *     with the same schema is a no-op.
 *   - Computed/expression columns are skipped (no storage).
 *   - uniqueOn produces a UNIQUE INDEX (best-effort; logged-and-skipped on
 *     constraint conflicts so a deploy can recover from pre-existing dupes).
 *
 * This is the single source of truth for "does an alive table match the
 * current schema?" — call it on every DO cold-start (via
 * `ensureAllCollectionTables`) and column-additive migrations propagate
 * automatically as DOs cycle.
 */

import {
  collectionTableName,
  resolveColumn,
  columnId,
  type CollectionSchema,
} from '../schemas/registry'

export interface MigrationLogger {
  warn(msg: string): void
}

const NOOP_LOGGER: MigrationLogger = { warn: () => {} }

export function ensureCollectionTable(
  sql: SqlStorage,
  schema: CollectionSchema,
  logger: MigrationLogger = NOOP_LOGGER,
): void {
  if (!schema.columns) return

  const tbl = collectionTableName(schema.name)
  const resolved = schema.columns.map(resolveColumn)

  const tableExists = sql.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tbl
  ).toArray().length > 0

  if (!tableExists) {
    const storageCols = resolved
      .filter(c => !c.expression)
      .map(c => `"${c.id}" ${c.storage === 'number' ? 'REAL' : 'TEXT'}`)
      .join(', ')

    const colClause = storageCols ? `, ${storageCols}` : ''
    sql.exec(`
      CREATE TABLE IF NOT EXISTS "${tbl}" (
        _row_id TEXT PRIMARY KEY,
        _created_by TEXT NOT NULL,
        _created_at TEXT NOT NULL,
        _updated_at TEXT NOT NULL${colClause}
      )
    `)
  } else {
    const existingCols = new Set<string>()
    const pragmaRows = sql.exec(`PRAGMA table_info("${tbl}")`).toArray()
    for (const row of pragmaRows) {
      existingCols.add((row as { name: string }).name)
    }

    for (const col of resolved) {
      if (col.expression) continue
      if (!existingCols.has(col.id)) {
        const sqlType = col.storage === 'number' ? 'REAL' : 'TEXT'
        sql.exec(`ALTER TABLE "${tbl}" ADD COLUMN "${col.id}" ${sqlType}`)
      }
    }
  }

  if (schema.uniqueOn && schema.uniqueOn.length > 0) {
    const uniqueCols = schema.uniqueOn.map(fieldName => {
      const col = resolved.find(c => c.name === fieldName)
      return col ? `"${col.id}"` : `"${columnId(fieldName)}"`
    })
    const indexName = `uniq_${tbl}_${schema.uniqueOn.join('_').replace(/[^a-zA-Z0-9_]/g, '_')}`
    try {
      sql.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${tbl}" (${uniqueCols.join(', ')})`
      )
    } catch (e) {
      logger.warn(
        `[RecordRoom] Cannot create UNIQUE index on ${tbl} (${schema.uniqueOn.join(', ')}): ${
          e instanceof Error ? e.message : e
        }`,
      )
    }
  }
}
