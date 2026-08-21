const APP_MIGRATION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_APP_MIGRATION_IDS = 256

/** Asset-layer misses became real 404s, and the worker owns the fallback. The
 *  config and the worker's fallback path have to move together. */
export const WORKER_OWNED_NOT_FOUND_MIGRATION_ID = '2026-08-worker-owned-not-found'

/** Room identity moved to internal headers and privileged room routes gained app-role checks. */
export const SECURE_ROOM_BOUNDARIES_MIGRATION_ID = '2026-08-secure-room-boundaries'

/** `ActionTools` gained `deleteWhere`, so the app's own tools factory — which
 *  declares that interface as its return type — has to supply it. */
export const ACTION_TOOLS_DELETE_WHERE_MIGRATION_ID = '2026-08-action-tools-delete-where'

/** The browser's app id moved off a scaffold-time literal onto a build-time
 *  define that `deepspace/build` reads from the wrangler config being built. */
export const BUILD_INJECTED_APP_ID_MIGRATION_ID = '2026-08-build-injected-app-id'

/** The action route refuses a call without a bearer token as 401 (a cookie
 *  session has none) instead of crashing on a non-null assertion, and the
 *  file states the trust model actions run under. */
export const ACTION_ROUTES_BEARER_GUARD_MIGRATION_ID = '2026-08-action-routes-bearer-guard'

export type AppMigrationIdsValidation =
  | { valid: true; ids: string[] }
  | { valid: false; reason: string }

/** Validate the small, provider-neutral migration manifest shipped with an app bundle. */
export function validateAppMigrationIds(value: unknown): AppMigrationIdsValidation {
  if (!Array.isArray(value)) {
    return { valid: false, reason: 'app migrations must be a JSON string array' }
  }
  if (value.length > MAX_APP_MIGRATION_IDS) {
    return {
      valid: false,
      reason: `app migrations cannot contain more than ${MAX_APP_MIGRATION_IDS} entries`,
    }
  }

  const ids: string[] = []
  const seen = new Set<string>()
  for (const valueId of value) {
    if (typeof valueId !== 'string' || !APP_MIGRATION_ID_RE.test(valueId)) {
      return { valid: false, reason: `invalid app migration id: ${String(valueId)}` }
    }
    if (seen.has(valueId)) {
      return { valid: false, reason: `duplicate app migration id: ${valueId}` }
    }
    seen.add(valueId)
    ids.push(valueId)
  }
  return { valid: true, ids }
}
