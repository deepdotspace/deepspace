import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ID_ADOPTION_EDITS, APP_ID_ADOPTION_TOGETHER } from '../../../build/app-id'
import {
  ACTION_ROUTES_BEARER_GUARD_MIGRATION_ID,
  ACTION_TOOLS_DELETE_WHERE_MIGRATION_ID,
  BUILD_INJECTED_APP_ID_MIGRATION_ID,
  SECURE_ROOM_BOUNDARIES_MIGRATION_ID,
  WORKER_OWNED_NOT_FOUND_MIGRATION_ID,
  validateAppMigrationIds,
} from '../../../shared/protocol/app-migrations'
import { Refusal } from '../../lib/command'

export const APP_MIGRATIONS_MANIFEST = 'deepspace.migrations.json'

/**
 * Source migrations are app-owned changes, so the CLI describes them instead
 * of guessing at arbitrary repository files. After applying and validating a
 * change, the developer records its id in the app's migration manifest.
 */
export interface AppMigrationGuidance {
  id: string
  description: string
  files: readonly string[]
  guidance: string
}

export const APP_MIGRATION_GUIDANCE: readonly AppMigrationGuidance[] = [
  {
    id: WORKER_OWNED_NOT_FOUND_MIGRATION_ID,
    description: 'Let the worker answer misses, so deleted files 404 instead of serving HTML',
    files: ['wrangler.toml', 'worker.ts or the app-owned HTTP route file'],
    guidance:
      'Set assets.not_found_handling to "none". In the worker asset fallback, return 404 when the last path segment names a file (contains a dot), and fetch "/" for client routes instead of "/index.html".',
  },
  {
    id: SECURE_ROOM_BOUNDARIES_MIGRATION_ID,
    description: 'Secure room identity, job mutations, and production debug routes',
    files: ['app-owned room proxy', 'AppJobRoom', 'debug-route handler'],
    guidance:
      'Forward verified room identity with authenticatedRoomRequest() rather than URL query parameters. Give AppJobRoom an authorizeWrite role check, and require verified admin access inside enabled debug routes.',
  },
  {
    id: ACTION_TOOLS_DELETE_WHERE_MIGRATION_ID,
    description: 'Add the deleteWhere method required by ActionTools',
    files: ['src/server/action-routes.ts, when the app has an ActionTools factory'],
    guidance:
      "Add `deleteWhere: (collection, where, limit) => execTool('records.deleteWhere', { collection, where, limit })` to the object returned as ActionTools. If the app has no ActionTools factory, record this migration as not applicable.",
  },
  {
    id: BUILD_INJECTED_APP_ID_MIGRATION_ID,
    description: "Read the browser's app id from the wrangler config selected for the build",
    files: ['src/constants.ts', 'vite.config.ts', 'vitest.config.ts when present'],
    guidance: `${APP_ID_ADOPTION_EDITS['src/constants.ts']} ${APP_ID_ADOPTION_EDITS['vite.config.ts']} ${APP_ID_ADOPTION_EDITS['vitest.config.ts']} ${APP_ID_ADOPTION_TOGETHER}`,
  },
  {
    id: ACTION_ROUTES_BEARER_GUARD_MIGRATION_ID,
    description: 'Refuse action calls without a bearer token and document their trust boundary',
    files: ['src/server/action-routes.ts, when the app has server actions'],
    guidance:
      "After resolveAuth, read `const authHeader = c.req.header('Authorization') ?? ''`, accept only its `Bearer ` token, and return 401 when absent. Document that X-App-Action bypasses per-record RBAC, so each action must authorize record ownership itself. If the app has no server action route, record this migration as not applicable.",
  },
]

export const APP_MIGRATION_DEFINITIONS = APP_MIGRATION_GUIDANCE.map(({ id, description }) => ({
  id,
  description,
}))

/** Read the provider-neutral migration ledger shipped with an app bundle. */
export function readAppliedAppMigrations(appDir: string): string[] {
  const path = join(appDir, APP_MIGRATIONS_MANIFEST)
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Refusal(
      `${APP_MIGRATIONS_MANIFEST} must contain valid JSON`,
      'invalid_migration_manifest',
    )
  }
  const validation = validateAppMigrationIds(parsed)
  if (!validation.valid) {
    throw new Refusal(
      `${APP_MIGRATIONS_MANIFEST}: ${validation.reason}`,
      'invalid_migration_manifest',
    )
  }
  return validation.ids
}

/** The guidance still outstanding according to the app-owned ledger. */
export function pendingAppMigrationGuidance(appDir: string): AppMigrationGuidance[] {
  const applied = new Set(readAppliedAppMigrations(appDir))
  return APP_MIGRATION_GUIDANCE.filter(({ id }) => !applied.has(id))
}
