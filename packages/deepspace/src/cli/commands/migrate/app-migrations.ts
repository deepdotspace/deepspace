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
  CANONICAL_APP_IDENTITY_MIGRATION_ID,
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

interface SourceMigration extends AppMigrationDefinition {
  transform(source: string): SourceTransformResult
  findBlockers(source: string, file: string): AppMigrationBlocker[]
}

/**
 * Ordered migration registry. Future breaking releases add a structural,
 * idempotent step here; callers keep using `deepspace app migrate`.
 */
const SOURCE_MIGRATIONS: readonly SourceMigration[] = [
  {
    id: CANONICAL_APP_IDENTITY_MIGRATION_ID,
    description: 'Use the immutable app id for authenticated platform requests',
    transform: migrateCanonicalIdentityWire,
    findBlockers: findLegacyIdentityWireBlockers,
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
      const result = migration.transform(after)
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

/** Apply exactly the content captured by a clean plan. */
export function applyAppMigrationPlan(appDir: string, plan: AppMigrationPlan): void {
  if (plan.blockers.length > 0) {
    throw new Error('Cannot apply an app migration plan with unresolved blockers.')
  }
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
  return /\.(?:[cm]?[jt]sx?)$/.test(repoPath)
}

function migrateCanonicalIdentityWire(source: string): SourceTransformResult {
  let replacements = 0
  const lines = source.split('\n')

  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!
    line = line.replace(
      /(\.set\(\s*)(['"])x-app-name\2(\s*,\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.APP_NAME(\s*\))/g,
      (_match, open: string, quote: string, separator: string, receiver: string, close: string) => {
        replacements++
        return `${open}${quote}x-app-id${quote}${separator}${receiver}.DEEPSPACE_APP_ID${close}`
      },
    )
    line = line.replace(
      /(['"])x-app-name\1(\s*:\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.APP_NAME/g,
      (_match, quote: string, separator: string, receiver: string) => {
        replacements++
        return `${quote}x-app-id${quote}${separator}${receiver}.DEEPSPACE_APP_ID`
      },
    )
    line = line.replace(
      /(\[\s*)(['"])x-app-name\2(\s*\]\s*=\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.APP_NAME/g,
      (_match, open: string, quote: string, separator: string, receiver: string) => {
        replacements++
        return `${open}${quote}x-app-id${quote}${separator}${receiver}.DEEPSPACE_APP_ID`
      },
    )
    line = line.replace(
      /(forwardedParams\.set\(\s*)(['"])appName\2(\s*,\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.APP_NAME(\s*\))/g,
      (_match, open: string, quote: string, separator: string, receiver: string, close: string) => {
        replacements++
        return `${open}${quote}appId${quote}${separator}${receiver}.DEEPSPACE_APP_ID${close}`
      },
    )
    lines[index] = line
  }

  if (replacements === 0) return { source, replacements }
  let migrated = lines.join('\n')
  if (/forwardedParams\.set\(\s*['"]appId['"]/.test(migrated)) {
    migrated = migrated
      .replaceAll('injectAppName', 'injectAppId')
      .replaceAll('`?appName=...`', '`?appId=...`')
      .replaceAll('Inject appName into the query string', 'Inject appId into the query string')
      .replaceAll('caller-supplied appName', 'caller-supplied appId')
      .replaceAll(
        '/_deepspace/subscriptions/plans?appName=',
        '/_deepspace/subscriptions/plans?appId=',
      )
  }
  migrated = migrated.replaceAll(
    'APP_IDENTITY_TOKEN + APP_NAME',
    'APP_IDENTITY_TOKEN + DEEPSPACE_APP_ID',
  )
  return {
    source: ensureCanonicalIdentityProperties(migrated),
    replacements,
  }
}

function ensureCanonicalIdentityProperties(source: string): string {
  const lines = source.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /^(\s*)(?:readonly\s+)?APP_NAME\??\s*:\s*string\s*([;,]?)\s*$/.exec(lines[index]!)
    if (!match || blockAlreadyDeclaresCanonicalId(lines, index, match[1]!.length)) continue
    const suffix = match[2] ?? ''
    lines.splice(index + 1, 0, `${match[1]}DEEPSPACE_APP_ID: string${suffix}`)
  }
  return lines.join('\n')
}

function blockAlreadyDeclaresCanonicalId(
  lines: string[],
  propertyIndex: number,
  propertyIndent: number,
): boolean {
  for (const direction of [-1, 1] as const) {
    for (
      let index = propertyIndex + direction;
      index >= 0 && index < lines.length;
      index += direction
    ) {
      const line = lines[index]!
      if (/^\s*(?:readonly\s+)?DEEPSPACE_APP_ID\??\s*:/.test(line)) return true
      const trimmed = line.trimStart()
      if (!trimmed) continue
      const indent = line.length - trimmed.length
      if (indent < propertyIndent && (trimmed.includes('{') || trimmed.startsWith('}'))) break
    }
  }
  return false
}

function findLegacyIdentityWireBlockers(source: string, file: string): AppMigrationBlocker[] {
  const blockers: AppMigrationBlocker[] = []
  for (const [index, line] of source.split('\n').entries()) {
    const trimmed = line.trimStart()
    if (
      !/['"]x-app-name['"]/.test(line) ||
      /\.delete\(\s*['"]x-app-name['"]/.test(line) ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      continue
    }
    blockers.push({
      migrationId: CANONICAL_APP_IDENTITY_MIGRATION_ID,
      file,
      line: index + 1,
      message:
        'This app still sends the removed x-app-name identity header in a form the safe migration cannot rewrite.',
    })
  }
  return blockers
}
