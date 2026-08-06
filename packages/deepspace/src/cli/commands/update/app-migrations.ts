import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  WORKER_OWNED_NOT_FOUND_MIGRATION_ID,
  validateAppMigrationIds,
} from '../../../shared/protocol/app-migrations'
import { repoToplevel } from '../../lib/git/repository'
import { gitLine, runGit, splitNulFields } from '../../lib/git/process'

export const APP_MIGRATIONS_MANIFEST = 'deepspace.migrations.json'

export interface AppMigrationDefinition {
  id: string
  description: string
}

export interface PlannedAppMigration extends AppMigrationDefinition {
  files: string[]
  replacements: number
}

export interface AppMigrationBlocker {
  migrationId: string
  file: string
  line: number
  message: string
}

export interface AppMigrationPlan {
  pending: PlannedAppMigration[]
  changedFiles: string[]
  blockers: AppMigrationBlocker[]
  /** Internal content snapshot used to make plan/apply deterministic. */
  edits: Array<{ path: string; before: string | null; after: string }>
}

interface SourceTransformResult {
  source: string
  replacements: number
}

/**
 * A migration is two halves with one rule between them: `transform` must leave
 * the app CORRECT ON ITS OWN, and `findBlockers` reports only what is left over
 * — never something the transform's own output depends on. A transform that
 * cannot finish a file must decline it (zero replacements) rather than half-do
 * it, because edits are applied even when blockers remain; that is the point of
 * the command.
 *
 * Both run against post-transform content, so `findBlockers` sees what the app
 * will actually contain.
 */
interface SourceMigration extends AppMigrationDefinition {
  transform(source: string, file: string): SourceTransformResult
  findBlockers(source: string, file: string): AppMigrationBlocker[]
}

/**
 * Ordered migration registry. Future breaking releases add a structural,
 * idempotent step here; callers keep using `deepspace app migrate`.
 */
const SOURCE_MIGRATIONS: readonly SourceMigration[] = [
  {
    id: WORKER_OWNED_NOT_FOUND_MIGRATION_ID,
    description: 'Let the worker answer misses, so deleted files 404 instead of serving HTML',
    transform: migrateWorkerOwnedNotFound,
    findBlockers: findWorkerOwnedNotFoundBlockers,
  },
]

export const APP_MIGRATION_DEFINITIONS: readonly AppMigrationDefinition[] = SOURCE_MIGRATIONS.map(
  ({ id, description }) => ({ id, description }),
)

/** Read migration state without consulting Git, so ordinary GitHub deploy stays manual. */
export function readAppliedAppMigrations(appDir: string): string[] {
  const path = join(appDir, APP_MIGRATIONS_MANIFEST)
  if (!existsSync(path)) return []
  const source = readRegularFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error(`${APP_MIGRATIONS_MANIFEST} must contain valid JSON`)
  }
  const validation = validateAppMigrationIds(parsed)
  if (!validation.valid) {
    throw new Error(`${APP_MIGRATIONS_MANIFEST}: ${validation.reason}`)
  }
  return validation.ids
}

/** Build an in-memory migration plan without changing the checkout. */
export function planAppMigrations(appDir: string): AppMigrationPlan {
  const repo = repoToplevel(appDir)
  const appPrefix = gitLine(appDir, ['rev-parse', '--show-prefix'])
  const appliedIds = readAppliedAppMigrations(appDir)
  const applied = new Set(appliedIds)
  const pendingMigrations = SOURCE_MIGRATIONS.filter((migration) => !applied.has(migration.id))
  const tracked = splitNulFields(runGit(repo, ['ls-files', '-z']).stdout)
  const perMigration = new Map<string, PlannedAppMigration>()
  const blockers: AppMigrationBlocker[] = []
  const edits: AppMigrationPlan['edits'] = []

  for (const repoPath of tracked) {
    if (!isSourcePath(repoPath, appPrefix)) continue
    const absolutePath = join(repo, repoPath)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(absolutePath)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue

    const before = readRegularFile(absolutePath)
    let after = before
    for (const migration of pendingMigrations) {
      const result = migration.transform(after, repoPath)
      after = result.source
      if (result.replacements > 0) {
        const planned = perMigration.get(migration.id) ?? {
          id: migration.id,
          description: migration.description,
          files: [],
          replacements: 0,
        }
        planned.files.push(repoPath)
        planned.replacements += result.replacements
        perMigration.set(migration.id, planned)
      }
      blockers.push(...migration.findBlockers(after, repoPath))
    }
    if (after !== before) edits.push({ path: repoPath, before, after })
  }

  const pending = pendingMigrations.map((migration) => {
    const planned = perMigration.get(migration.id)
    return planned
      ? { ...planned, files: [...new Set(planned.files)].sort() }
      : { id: migration.id, description: migration.description, files: [], replacements: 0 }
  })

  if (pending.length > 0 && blockers.length === 0) {
    const manifestPath = `${appPrefix}${APP_MIGRATIONS_MANIFEST}`
    const absoluteManifestPath = join(repo, manifestPath)
    const before = existsSync(absoluteManifestPath) ? readRegularFile(absoluteManifestPath) : null
    const after = `${JSON.stringify([...appliedIds, ...pending.map(({ id }) => id)], null, 2)}\n`
    if (before !== after) edits.push({ path: manifestPath, before, after })
  }

  return {
    pending,
    changedFiles: edits.map((edit) => edit.path).sort(),
    blockers,
    edits,
  }
}

/**
 * Apply exactly the content captured by the plan.
 *
 * Blockers do NOT hold the edits back: each transform's output stands on its
 * own (see SourceMigration), so withholding it would leave the app on the old
 * behavior for the sake of a change the author still has to make by hand. What
 * a blocker does hold back is the manifest stamp — planAppMigrations only
 * records a migration as applied once nothing is outstanding, so the next
 * `update` looks again.
 */
export function applyAppMigrationPlan(appDir: string, plan: AppMigrationPlan): void {
  const repo = repoToplevel(appDir)
  for (const edit of plan.edits) {
    const absolutePath = join(repo, edit.path)
    const current = existsSync(absolutePath) ? readRegularFile(absolutePath) : null
    if (current !== edit.before) {
      throw new Error(`Migration input changed after planning: ${edit.path}`)
    }
  }
  for (const edit of plan.edits) writeRegularFile(join(repo, edit.path), edit.before, edit.after)
}

/** Read through a descriptor and prove the path still names that regular file. */
function readRegularFile(path: string): string {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Migration input must be a regular file, not a symlink: ${path}`)
  }
  const fd = openSync(path, constants.O_RDONLY)
  try {
    const opened = fstatSync(fd)
    const after = lstatSync(path)
    if (!opened.isFile() || opened.dev !== after.dev || opened.ino !== after.ino) {
      throw new Error(`Migration input changed while opening: ${path}`)
    }
    return readFileSync(fd, 'utf-8')
  } finally {
    closeSync(fd)
  }
}

/** Revalidate and write the same opened inode; new files use exclusive creation. */
function writeRegularFile(path: string, before: string | null, after: string): void {
  if (before === null) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644)
    try {
      writeSync(fd, after, 0, 'utf-8')
    } finally {
      closeSync(fd)
    }
    return
  }

  const pathStat = lstatSync(path)
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`Migration input must be a regular file, not a symlink: ${path}`)
  }
  const fd = openSync(path, constants.O_RDWR)
  try {
    const opened = fstatSync(fd)
    const currentPath = lstatSync(path)
    if (!opened.isFile() || opened.dev !== currentPath.dev || opened.ino !== currentPath.ino) {
      throw new Error(`Migration input changed while opening: ${path}`)
    }
    if (readFileSync(fd, 'utf-8') !== before) {
      throw new Error(`Migration input changed after planning: ${path}`)
    }
    ftruncateSync(fd, 0)
    writeSync(fd, after, 0, 'utf-8')
  } finally {
    closeSync(fd)
  }
}

function isSourcePath(repoPath: string, appPrefix: string): boolean {
  if (appPrefix && !repoPath.startsWith(appPrefix)) return false
  // wrangler.toml carries routing config a migration may have to move in step
  // with the worker code that depends on it.
  if (repoPath.endsWith('wrangler.toml')) return true
  return /\.(?:[cm]?[jt]sx?)$/.test(repoPath)
}


/**
 * Deploys used to tell Cloudflare's asset layer to answer ANY unmatched path
 * with index.html at 200 — right for a client route, wrong for a file, and it
 * meant a deleted build chunk came back as HTML a script tag could not parse.
 * The asset layer cannot tell those apart; the worker can, so the decision
 * moved there and the layer now reports a real 404.
 *
 * Three edits have to travel together, or the app breaks:
 *
 *  1. the config that stops the asset layer inventing answers;
 *  2. the worker's fallback target, which must ask for `/` — asking for
 *     `/index.html` gets a redirect to `/`, which the worker hands to the
 *     browser, dropping it off the URL it asked for;
 *  3. a guard in front of that fallback, so a path naming a FILE 404s instead
 *     of receiving the shell. Without it, step 1 changes nothing for the case
 *     that motivated it: a stale chunk request still gets HTML at 200.
 */
function migrateWorkerOwnedNotFound(source: string, file: string): SourceTransformResult {
  let replacements = 0

  if (file.endsWith('wrangler.toml')) {
    const next = source.replace(/not_found_handling\s*=\s*"single-page-application"/g, () => {
      replacements++
      return 'not_found_handling = "none"'
    })
    return { source: next, replacements }
  }

  const retargeted = source.replace(
    /(url\.pathname\s*=\s*)(['"])\/index\.html\2/g,
    (_match, assignment: string, quote: string) => {
      replacements++
      return `${assignment}${quote}/${quote}`
    },
  )
  const guarded = insertFileMissGuard(retargeted)
  return { source: guarded.source, replacements: replacements + guarded.replacements }
}

/** Recognizes the fallback line this migration owns: `url.pathname = '/'`. */
const SHELL_FALLBACK_LINE = /^(\s*)url\.pathname\s*=\s*(['"])\/\2\s*$/

/** How far back to look for an existing guard before adding one. */
const GUARD_LOOKBACK_LINES = 8

/**
 * Put a file-vs-route check in front of the shell fallback.
 *
 * Anchored on the line the migration itself produces, so the insertion point is
 * exact rather than inferred, and written inline rather than imported: this is
 * the app author's file, and the current scaffold spells it out there too.
 */
function insertFileMissGuard(source: string): SourceTransformResult {
  const lines = source.split('\n')
  let replacements = 0

  for (let index = lines.length - 1; index >= 0; index--) {
    const match = SHELL_FALLBACK_LINE.exec(lines[index]!)
    if (!match || hasFileMissGuard(lines, index)) continue
    const indent = match[1]!
    lines.splice(
      index,
      0,
      `${indent}// A FILE, not a client route: a miss must 404. Returning the shell here`,
      `${indent}// is HTML parsed as JavaScript, which is a blank page.`,
      `${indent}if (${FILE_MISS_TEST}) {`,
      `${indent}  return c.json({ error: 'not_found' }, 404)`,
      `${indent}}`,
    )
    replacements++
  }
  return { source: lines.join('\n'), replacements }
}

/** Same rule as the scaffold's `namesAFile`: the last segment carries a dot. */
const FILE_MISS_TEST = "url.pathname.slice(url.pathname.lastIndexOf('/') + 1).includes('.')"

/**
 * Whether the lines above the fallback already decide file-vs-route — this
 * migration's own guard on a re-run, or the scaffold's `namesAFile` in an app
 * that was updated by hand.
 */
function hasFileMissGuard(lines: string[], fallbackIndex: number): boolean {
  const start = Math.max(0, fallbackIndex - GUARD_LOOKBACK_LINES)
  return lines
    .slice(start, fallbackIndex)
    .some((line) => line.includes(FILE_MISS_TEST) || /\bnamesAFile\s*\(/.test(line))
}

/**
 * What the transform could not finish, stated exactly enough to act on.
 *
 * Runs on post-transform content: a worker that STILL asks the asset layer for
 * `/index.html` wrote that path in some form the rewrite above does not match,
 * and left alone it costs the app every deep link — the browser gets the
 * redirect and lands on `/`.
 */
function findWorkerOwnedNotFoundBlockers(source: string, file: string): AppMigrationBlocker[] {
  if (file.endsWith('wrangler.toml')) return []
  if (!source.includes('ASSETS')) return []

  const blockers: AppMigrationBlocker[] = []
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    // The quote has to sit against the leading slash: a build config naming
    // './index.html' is not this worker serving a shell.
    if (!/['"`]\/index\.html/.test(line)) continue
    blockers.push({
      migrationId: WORKER_OWNED_NOT_FOUND_MIGRATION_ID,
      file,
      line: index + 1,
      message:
        `This worker still asks the asset layer for "/index.html". Deploys now set ` +
        `not_found_handling = "none", and "/index.html" redirects to "/" — the browser ` +
        `follows it and loses the path it asked for. Fetch "/" instead, and 404 first when ` +
        `the last path segment contains a "." (a file, not a client route).`,
    })
  }
  return blockers
}
