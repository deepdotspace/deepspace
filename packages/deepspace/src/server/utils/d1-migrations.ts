/**
 * Lightweight D1 schema bootstrapping for apps that use auto-provisioned
 * `[[d1_databases]]` bindings.
 *
 * The auto-provisioner gives apps an empty D1; the app needs to create its
 * own tables before using them. This helper runs ordered SQL fragments and
 * tracks which have applied via a `_dpc_migrations` meta-table so re-running
 * is a no-op:
 *
 * ```ts
 * import { runMigrations } from 'deepspace/worker'
 *
 * await runMigrations(env.CARDS_DB, [
 *   `CREATE TABLE cards (id INTEGER PRIMARY KEY, json TEXT NOT NULL);`,
 *   `CREATE INDEX idx_cards_updated ON cards(updated_at);`,
 * ])
 * ```
 *
 * **SQL formatting:** statements may span multiple lines freely. The runner
 * splits each migration string on `;` and runs each fragment via
 * `prepare().run()`. That sidesteps `db.exec()`'s newline-or-semicolon quirks
 * (it's optimized for migration files, not inline strings) and gets you
 * predictable single-statement semantics. Trailing `;` after the last
 * statement is fine; semicolons inside string literals are not (we use a
 * naive split, since DDL almost never has them).
 *
 * Each entry in the array is one migration. The runner records the index of
 * each successfully-applied migration in `_dpc_migrations`; subsequent calls
 * skip rows already recorded. Adding a new migration means appending to the
 * array; never reorder or delete entries.
 *
 * Why a meta-table instead of `PRAGMA user_version`: D1's SQLite authorizer
 * rejects PRAGMA writes with `SQLITE_AUTH`, even though the same statements
 * work in raw SQLite. A real table works on any D1 database and stays a
 * trivial bootstrap (one CREATE TABLE IF NOT EXISTS).
 *
 * Concurrency: D1 serializes statements per database, but two simultaneous
 * `runMigrations` callers could race the same migration index. The duplicate
 * INSERT collides on the primary key and the second caller sees the failure
 * — but the migration itself uses `IF NOT EXISTS` so the schema is correct
 * either way. Apps invoke this at startup which is single-threaded per
 * worker isolate; the cross-isolate race is rare and self-healing.
 *
 * This is the simplest possible migration story (option 1 in
 * docs/proposals/binding-auto-provisioning.md). Apps that outgrow it can
 * adopt CF's `wrangler d1 migrations apply` directly without breaking the
 * helper.
 */

const META_TABLE = '_dpc_migrations'
// Single-statement DDL — runs through prepare().run(), not exec(). exec()
// is documented as newline-separated statements for migration files; the
// binding's behavior on a single statement with a trailing ';' has been
// flaky in practice and prepare()/run() is the right shape anyway.
const META_BOOTSTRAP_SQL = `CREATE TABLE IF NOT EXISTS ${META_TABLE} (idx INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`

export interface RunMigrationsResult {
  /** Version before this run started. Equals the count of migrations already applied. */
  fromVersion: number
  /** Version after migrations applied. Equals fromVersion if nothing ran. */
  toVersion: number
  /** Number of migrations applied this call. */
  applied: number
}

/**
 * Apply ordered SQL migrations to a D1 database. Idempotent: the next call
 * with the same array is a no-op until the array grows.
 *
 * Throws on any individual migration failure. The migrations meta-row is
 * only inserted after a migration succeeds, so a partial failure leaves a
 * recoverable state — fix the SQL, redeploy, and the failed migration runs
 * on next startup.
 */
export async function runMigrations(
  db: D1Database,
  migrations: readonly string[],
): Promise<RunMigrationsResult> {
  // Bootstrap the meta-table. Single statement → prepare().run().
  await db.prepare(META_BOOTSTRAP_SQL).run()

  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${META_TABLE}`)
    .first<{ n: number }>()
  const fromVersion = row?.n ?? 0

  if (fromVersion >= migrations.length) {
    return { fromVersion, toVersion: fromVersion, applied: 0 }
  }

  let current = fromVersion
  for (let i = fromVersion; i < migrations.length; i++) {
    const statements = splitStatements(migrations[i])
    for (const stmt of statements) {
      try {
        await db.prepare(stmt).run()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Migration ${i} failed (db at version=${current}): ${msg}`)
      }
    }
    // Record the applied migration. PK collision (duplicate idx from a
    // concurrent run) surfaces as an error and we abort — but the schema
    // is already in place, so the next attempt sees fromVersion advance
    // and skips it.
    await db
      .prepare(`INSERT INTO ${META_TABLE} (idx, applied_at) VALUES (?, ?)`)
      .bind(i, new Date().toISOString())
      .run()
    current = i + 1
  }

  return { fromVersion, toVersion: current, applied: current - fromVersion }
}

/**
 * Naive `;` split: good enough for DDL where the only semicolons are
 * statement terminators. Strings with embedded `;` inside literals would
 * break this — accept that tradeoff because real migrations rarely contain
 * them and the alternative is shipping a SQL parser.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
