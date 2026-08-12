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
  SECURE_ROOM_BOUNDARIES_MIGRATION_ID,
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
 * idempotent step here; callers keep using `deepspace app update`.
 */
const SOURCE_MIGRATIONS: readonly SourceMigration[] = [
  {
    id: WORKER_OWNED_NOT_FOUND_MIGRATION_ID,
    description: 'Let the worker answer misses, so deleted files 404 instead of serving HTML',
    transform: migrateWorkerOwnedNotFound,
    findBlockers: findWorkerOwnedNotFoundBlockers,
  },
  {
    id: SECURE_ROOM_BOUNDARIES_MIGRATION_ID,
    description: 'Secure room identity, job mutations, and production debug routes',
    transform: migrateSecureRoomBoundaries,
    findBlockers: findSecureRoomBoundaryBlockers,
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

    // Match against LF text, but keep the checkout's own bytes as the snapshot:
    // a CRLF working tree is what Git hands every Windows clone, not evidence
    // that the author edited the file. See normalizeEol.
    const checkout = readRegularFile(absolutePath)
    const before = normalizeEol(checkout)
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
    // `before` is the raw checkout so the apply-time drift check stays
    // byte-exact; `after` is handed back in the checkout's own endings so a
    // CRLF file is not rewritten line-for-line.
    if (after !== before) {
      edits.push({ path: repoPath, before: checkout, after: restoreEol(after, checkout) })
    }
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

/**
 * Line endings are a checkout artifact, never a customization.
 *
 * Git for Windows ships `core.autocrlf=true` at system level and scaffolded
 * apps carry no `.gitattributes`, so every Windows clone materializes CRLF.
 * The seams below are LF template literals matched by exact substring, so
 * without this every multi-line migration declined on Windows AND reported the
 * stock file as customized — an exit-2 blocker naming code the author never
 * touched, which then never stamped the manifest and re-reported forever.
 *
 * Normalizing here rather than in each seam keeps every future migration
 * ending-oblivious: authors go on writing plain LF constants.
 */
function normalizeEol(source: string): string {
  return source.replaceAll('\r\n', '\n')
}

/** Give a transformed file back the line endings its checkout actually uses. */
function restoreEol(source: string, checkout: string): string {
  return checkout.includes('\r\n') ? source.replaceAll('\n', '\r\n') : source
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

const LEGACY_AUTHENTICATED_ROOM_HELPER = `const IDENTITY_QUERY_PARAMS = ['userId', 'userName', 'userEmail', 'userImageUrl', 'role'] as const

function authenticatedRoomUrl(
  requestUrl: string,
  auth: VerifyResult | null,
  extraParams?: (auth: VerifyResult) => Record<string, string>,
): URL {
  const doUrl = new URL(requestUrl)
  doUrl.searchParams.delete('token')
  for (const key of IDENTITY_QUERY_PARAMS) {
    doUrl.searchParams.delete(key)
  }

  if (!auth) return doUrl

  doUrl.searchParams.set('userId', auth.userId)
  if (auth.claims.name) doUrl.searchParams.set('userName', auth.claims.name)
  if (auth.claims.email) doUrl.searchParams.set('userEmail', auth.claims.email)
  if (auth.claims.image) doUrl.searchParams.set('userImageUrl', auth.claims.image)
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams(auth))) {
      doUrl.searchParams.set(key, value)
    }
  }
  return doUrl
}`

const IDENTITY_ROUTE_REPLACEMENTS: ReadonlyArray<readonly [string, string, number]> = [
  [
    `import { verifyJwt } from 'deepspace/worker'`,
    `import { authenticatedRoomRequest, verifyJwt } from 'deepspace/worker'`,
    1,
  ],
  [LEGACY_AUTHENTICATED_ROOM_HELPER, '', 1],
  [
    `function wsRoute(
  doNamespace: (env: Env) => DurableObjectNamespace,
  extraParams?: (auth: VerifyResult) => Record<string, string>,
) {`,
    `function wsRoute(
  doNamespace: (env: Env) => DurableObjectNamespace,
  extraIdentity?: (auth: VerifyResult) => { role?: string },
) {`,
    1,
  ],
  [
    `    const doUrl = authenticatedRoomUrl(c.req.url, auth, extraParams)`,
    `    const roomRequest = authenticatedRoomRequest(
      c.req.raw,
      auth,
      auth ? extraIdentity?.(auth) : undefined,
    )`,
    1,
  ],
  [
    `    const doUrl = authenticatedRoomUrl(c.req.url, auth, () => ({ role }))`,
    `    const roomRequest = authenticatedRoomRequest(c.req.raw, auth, { role })`,
    1,
  ],
  [
    `    return stub.fetch(new Request(doUrl.toString(), c.req.raw))`,
    `    return stub.fetch(roomRequest)`,
    2,
  ],
]

function occurrences(source: string, pattern: string): number {
  return source.split(pattern).length - 1
}

const SECURE_JOB_ROOM_CONSTRUCTOR = `  constructor(state: DurableObjectState, env: Env) {
    super(state, env, {
      authorizeWrite: async (user) => {
        if (user.userId.startsWith('anon-')) return false
        const role = await resolveAppRole(env, user.userId)
        return role === 'member' || role === 'admin'
      },
    })
  }`

const APP_JOB_ROOM_CLASS = `export class AppJobRoom extends JobRoom<Env> {`
const SECURE_APP_JOB_ROOM = `${APP_JOB_ROOM_CLASS}
${SECURE_JOB_ROOM_CONSTRUCTOR}`

function hasSecureAppJobRoom(source: string): boolean {
  return occurrences(source, 'class AppJobRoom') === 1 && source.includes(SECURE_APP_JOB_ROOM)
}

const WORKER_JOB_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [
    `import type { DOBindings, DOManifest, Job, JobContext } from 'deepspace/worker'`,
    `import { resolveAppRole } from 'deepspace/worker'
import type { DOBindings, DOManifest, Job, JobContext } from 'deepspace/worker'`,
  ],
  [
    `export class AppJobRoom extends JobRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
  }`,
    `export class AppJobRoom extends JobRoom<Env> {
${SECURE_JOB_ROOM_CONSTRUCTOR}`,
  ],
]

const HTTP_ROLE_IMPORT = `import { resolveAppRole } from 'deepspace/worker'`
const HTTP_ROLE_IMPORT_PATTERN =
  /\bimport\s*\{[^}]*\bresolveAppRole\b[^}]*\}\s*from\s*(['"])deepspace\/worker\1/
const HTTP_ROLE_IMPORT_SEAM = `import type { AppContext, Env } from '../../worker.js'`
const DEBUG_ROUTE_SEAM = `  app.all('/api/debug/*', async (c) => {
    if (c.env.ALLOW_DEBUG_ROUTES !== 'true') {
      return c.notFound()
    }
    const stub = c.env.RECORD_ROOMS.get(`
const DOUBLE_QUOTED_DEBUG_ROUTE_SEAM = DEBUG_ROUTE_SEAM.replace(
  "app.all('/api/debug/*'",
  'app.all("/api/debug/*"',
)
const SECURE_DEBUG_ROUTE_SEAM = `  app.all('/api/debug/*', async (c) => {
    if (c.env.ALLOW_DEBUG_ROUTES !== 'true') {
      return c.notFound()
    }
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'unauthorized' }, 401)
    if ((await resolveAppRole(c.env, auth.userId)) !== 'admin') {
      return c.json({ error: 'forbidden' }, 403)
    }
    const stub = c.env.RECORD_ROOMS.get(`
const DOUBLE_QUOTED_SECURE_DEBUG_ROUTE_SEAM = SECURE_DEBUG_ROUTE_SEAM.replace(
  "app.all('/api/debug/*'",
  'app.all("/api/debug/*"',
)
const DEBUG_ROUTE_REPLACEMENTS = [
  [DEBUG_ROUTE_SEAM, SECURE_DEBUG_ROUTE_SEAM],
  [DOUBLE_QUOTED_DEBUG_ROUTE_SEAM, DOUBLE_QUOTED_SECURE_DEBUG_ROUTE_SEAM],
] as const
const DEBUG_ROUTE_PATTERN = /\bapp\.all\(\s*(['"])\/api\/debug\/\*\1\s*,/

function debugRouteOccurrences(source: string): number {
  return source.match(new RegExp(DEBUG_ROUTE_PATTERN.source, 'g'))?.length ?? 0
}

function secureDebugRouteOccurrences(source: string): number {
  return DEBUG_ROUTE_REPLACEMENTS.reduce(
    (count, [, secure]) => count + occurrences(source, secure),
    0,
  )
}

function httpRoleImportOccurrences(source: string): number {
  return source.match(new RegExp(HTTP_ROLE_IMPORT_PATTERN.source, 'g'))?.length ?? 0
}

function hasSecureDebugRoute(source: string): boolean {
  return (
    debugRouteOccurrences(source) === 1 &&
    secureDebugRouteOccurrences(source) === 1 &&
    httpRoleImportOccurrences(source) === 1
  )
}

/** Apply only when every stock seam in a file is present. */
function migrateSecureRoomBoundaries(source: string, file: string): SourceTransformResult {
  if (file.endsWith('src/server/realtime-routes.ts')) {
    return migrateRealtimeRoomBoundaries(source)
  }
  if (file.endsWith('worker.ts')) return migrateWorkerJobAuthorization(source)
  if (file.endsWith('src/server/http-routes.ts')) return migrateDebugRouteAuthorization(source)
  return { source, replacements: 0 }
}

function migrateRealtimeRoomBoundaries(source: string): SourceTransformResult {
  let migrated = source
  let replacements = 0
  // A file containing both generations is customized or partially migrated.
  // Leave it untouched so the blocker scan below can report the legacy seam.
  if (!migrated.includes('authenticatedRoomRequest(')) {
    if (
      IDENTITY_ROUTE_REPLACEMENTS.some(
        ([before, , expected]) => occurrences(migrated, before) !== expected,
      )
    ) {
      return { source, replacements: 0 }
    }
    for (const [before, after, expected] of IDENTITY_ROUTE_REPLACEMENTS) {
      migrated = migrated.replaceAll(before, after)
      replacements += expected
    }
  }

  return { source: migrated, replacements }
}

function migrateWorkerJobAuthorization(source: string): SourceTransformResult {
  if (!source.includes('class AppJobRoom')) return { source, replacements: 0 }
  if (hasSecureAppJobRoom(source)) return { source, replacements: 0 }
  if (WORKER_JOB_REPLACEMENTS.some(([before]) => occurrences(source, before) !== 1)) {
    return { source, replacements: 0 }
  }
  let migrated = source
  for (const [before, after] of WORKER_JOB_REPLACEMENTS) migrated = migrated.replace(before, after)
  return { source: migrated, replacements: WORKER_JOB_REPLACEMENTS.length }
}

function migrateDebugRouteAuthorization(source: string): SourceTransformResult {
  if (debugRouteOccurrences(source) === 0 || hasSecureDebugRoute(source)) {
    return { source, replacements: 0 }
  }
  const matchingRoutes = DEBUG_ROUTE_REPLACEMENTS.filter(
    ([before]) => occurrences(source, before) === 1,
  )
  if (
    debugRouteOccurrences(source) !== 1 ||
    matchingRoutes.length !== 1 ||
    httpRoleImportOccurrences(source) !== 0 ||
    occurrences(source, HTTP_ROLE_IMPORT_SEAM) !== 1
  ) {
    return { source, replacements: 0 }
  }
  const [before, after] = matchingRoutes[0]
  return {
    source: source
      .replace(HTTP_ROLE_IMPORT_SEAM, `${HTTP_ROLE_IMPORT_SEAM}\n${HTTP_ROLE_IMPORT}`)
      .replace(before, after),
    replacements: 2,
  }
}

function findSecureRoomBoundaryBlockers(source: string, file: string): AppMigrationBlocker[] {
  if (file.endsWith('worker.ts') && source.includes('class AppJobRoom')) {
    if (!hasSecureAppJobRoom(source)) {
      return [
        roomBoundaryBlocker(
          file,
          source,
          'class AppJobRoom',
          'Configure AppJobRoom with authorizeWrite using the current users.role.',
        ),
      ]
    }
    return []
  }
  if (file.endsWith('src/server/http-routes.ts') && debugRouteOccurrences(source) > 0) {
    if (!hasSecureDebugRoute(source)) {
      const route = source.match(DEBUG_ROUTE_PATTERN)?.[0] ?? '/api/debug/*'
      return [
        roomBoundaryBlocker(
          file,
          source,
          route,
          'Require verified owner/admin access inside the enabled debug-route handler.',
        ),
      ]
    }
    return []
  }
  if (!file.endsWith('src/server/realtime-routes.ts')) return []
  const lines = source.split('\n')
  let index = lines.findIndex(
    (line) =>
      line.includes('authenticatedRoomUrl') ||
      /searchParams\.(?:set|append)\(\s*['"](?:userId|userName|userEmail|userImageUrl|role)['"]/.test(
        line,
      ),
  )
  // Customized proxies sometimes rename the helper, inject identity through a
  // dynamic Object.entries loop, or construct the forwarded Request separately
  // from stub.fetch(). Fail closed on verified auth plus query mutation; the
  // header-safe scaffold only deletes public identity query inputs.
  if (index < 0 && /\bauth\.(?:userId|claims)\b/.test(source)) {
    index = lines.findIndex((line) => /searchParams\.(?:set|append)\s*\(/.test(line))
  }
  if (index < 0) return []
  return [
    {
      migrationId: SECURE_ROOM_BOUNDARIES_MIGRATION_ID,
      file,
      line: index + 1,
      message:
        'This customized room proxy still places verified user identity in its internal URL. Replace that forwarding code with authenticatedRoomRequest() from deepspace/worker before the Durable Object fetch.',
    },
  ]
}

function roomBoundaryBlocker(
  file: string,
  source: string,
  seam: string,
  message: string,
): AppMigrationBlocker {
  const line = source.slice(0, source.indexOf(seam)).split('\n').length
  return { migrationId: SECURE_ROOM_BOUNDARIES_MIGRATION_ID, file, line, message }
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
    // Match the two legacy executable shapes this migration owns. Plain text
    // in comments and build config entries such as './index.html' are not a
    // Worker shell fallback.
    if (!/(?:\burl\.pathname\s*=\s*|\bnew\s+URL\s*\(\s*)['"`]\/index\.html/.test(line)) {
      continue
    }
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
