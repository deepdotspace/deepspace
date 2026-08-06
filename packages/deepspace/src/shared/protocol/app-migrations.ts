const APP_MIGRATION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_APP_MIGRATION_IDS = 256

/** First source migration required by the canonical app identity cutover. */
export const CANONICAL_APP_IDENTITY_MIGRATION_ID = '2026-08-canonical-app-identity-wire'

/** Asset-layer misses became real 404s, and the worker owns the fallback. The
 *  config and the worker's fallback path have to move together. */
export const WORKER_OWNED_NOT_FOUND_MIGRATION_ID = '2026-08-worker-owned-not-found'

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
