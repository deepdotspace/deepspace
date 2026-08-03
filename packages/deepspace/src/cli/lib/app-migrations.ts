import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoToplevel } from './git/repository'
import { gitLine, runGit, splitNulFields } from './git/process'

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
  edits: Array<{ path: string; before: string; after: string }>
}

interface SourceTransformResult {
  source: string
  replacements: number
}

interface SourceMigration extends AppMigrationDefinition {
  transform(source: string): SourceTransformResult
  findBlockers(source: string, file: string): AppMigrationBlocker[]
}

const CANONICAL_IDENTITY_WIRE_ID = '2026-08-canonical-app-identity-wire'

/**
 * Ordered migration registry. Future breaking releases add a structural,
 * idempotent step here; callers keep using `deepspace app migrate`.
 */
const SOURCE_MIGRATIONS: readonly SourceMigration[] = [
  {
    id: CANONICAL_IDENTITY_WIRE_ID,
    description: 'Use the immutable app id for authenticated platform requests',
    transform: migrateCanonicalIdentityWire,
    findBlockers: findLegacyIdentityWireBlockers,
  },
]

export const APP_MIGRATION_DEFINITIONS: readonly AppMigrationDefinition[] = SOURCE_MIGRATIONS.map(
  ({ id, description }) => ({ id, description }),
)

/** Build an in-memory migration plan without changing the checkout. */
export function planAppMigrations(appDir: string): AppMigrationPlan {
  const repo = repoToplevel(appDir)
  const appPrefix = gitLine(appDir, ['rev-parse', '--show-prefix'])
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

    const before = readFileSync(absolutePath, 'utf-8')
    let after = before
    for (const migration of SOURCE_MIGRATIONS) {
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

  return {
    pending: SOURCE_MIGRATIONS.flatMap((migration) => {
      const planned = perMigration.get(migration.id)
      return planned ? [{ ...planned, files: [...new Set(planned.files)].sort() }] : []
    }),
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
    if (readFileSync(absolutePath, 'utf-8') !== edit.before) {
      throw new Error(`Migration input changed after planning: ${edit.path}`)
    }
  }
  for (const edit of plan.edits) writeFileSync(join(repo, edit.path), edit.after)
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
      migrationId: CANONICAL_IDENTITY_WIRE_ID,
      file,
      line: index + 1,
      message:
        'This app still sends the removed x-app-name identity header in a form the safe migration cannot rewrite.',
    })
  }
  return blockers
}
