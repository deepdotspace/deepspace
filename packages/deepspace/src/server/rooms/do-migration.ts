/**
 * Pure helpers for computing Cloudflare Durable Object migrations from a
 * declared manifest + the bindings already registered on a deployed script.
 *
 * Lives in the SDK (not deploy-worker) so the logic is testable with vitest
 * and reusable from other CF deploy paths if we ever add them.
 */

import type { DOManifestEntry } from './do-manifest'

/** Subset of CF's `bindings` API response we read from. */
export interface ExistingDOBinding {
  /** Binding name in `env`, e.g. 'RECORD_ROOMS' */
  name: string
  /** Always `'durable_object_namespace'` for DO bindings. */
  type: string
  /** SDK class name, e.g. 'AppRecordRoom' */
  class_name?: string
}

/** What goes in the CF script-upload `migrations` block. */
export interface DoMigrationDirective {
  tag: string
  new_sqlite_classes?: string[]
  deleted_classes?: string[]
}

export interface DoMigrationPlan {
  /** New SQLite classes to register (present in manifest, absent in existing). */
  newSqliteClasses: string[]
  /** Classes to delete (present in existing, absent in manifest). */
  deletedClasses: string[]
  /** True when there's actual delta — only then should the migrations block be sent. */
  needsMigration: boolean
  /** The full directive to splat into the CF script-upload metadata. Null if no migration is needed. */
  directive: DoMigrationDirective | null
}

export interface ComputeDoMigrationOptions {
  /**
   * Override for the timestamp baked into the migration tag. Tests pass a
   * fixed value to assert determinism; production omits this and gets
   * `Date.now()`, which guarantees lifetime tag uniqueness even across
   * cycles like `[A]→[A,B]→[A]→[A,B]`.
   */
  now?: number
}

/**
 * Compute the migration plan for a deploy.
 *
 *   manifest:   what the app declares now
 *   existing:   what CF currently has registered for this script
 *
 * Behavior:
 *   - new_sqlite_classes  ← in manifest, not in existing, sqlite=true
 *   - deleted_classes     ← in existing, not in manifest
 *   - needsMigration       ← either of the above is non-empty
 *   - tag                 ← content-addressed by (add, remove) so:
 *                            - identical re-deploy → unchanged tag → no-op (and
 *                              `needsMigration` is false anyway)
 *                            - any class change → unique tag → CF processes
 *
 * Bug history: an earlier version computed `tag = v${count}`. Removing a class
 * dropped the count, the migration block was skipped (no NEW classes), and CF
 * retained the orphaned class registration with its SQLite storage. The
 * `deleted_classes` path closes that gap; the content-addressed tag prevents
 * tag collisions when class sets are added and removed in different orders.
 */
export function computeDoMigration(
  manifest: readonly DOManifestEntry[],
  existing: readonly ExistingDOBinding[],
  options?: ComputeDoMigrationOptions,
): DoMigrationPlan {
  const existingNames = new Set(
    existing.filter((b) => b.type === 'durable_object_namespace').map((b) => b.name),
  )
  const manifestBindingNames = new Set(manifest.map((e) => e.binding))

  const newSqliteClasses = manifest
    .filter((e) => e.sqlite && !existingNames.has(e.binding))
    .map((e) => e.className)
    .sort()

  const deletedClasses = [...existingNames]
    .filter((name) => !manifestBindingNames.has(name))
    .map((name) => {
      // We need the className for `deleted_classes`. CF's bindings API returns
      // `class_name` per binding; fall back to the binding name when the API
      // didn't include it (older responses, or non-DO entries that slipped
      // through the type filter).
      const m = existing.find((b) => b.name === name)
      return m?.class_name ?? name
    })
    .sort()

  const needsMigration = newSqliteClasses.length > 0 || deletedClasses.length > 0
  const directive: DoMigrationDirective | null = needsMigration
    ? {
        tag: migrationTag(newSqliteClasses, deletedClasses, options),
        ...(newSqliteClasses.length ? { new_sqlite_classes: newSqliteClasses } : {}),
        ...(deletedClasses.length ? { deleted_classes: deletedClasses } : {}),
      }
    : null

  return { newSqliteClasses, deletedClasses, needsMigration, directive }
}

/**
 * Unique-per-deploy migration tag.
 *
 * CF requires tags to be unique *across the script's lifetime* — reusing a
 * tag rejects the deploy. Pure content-addressing (hash of add+remove) is
 * insufficient because cycles produce identical content: `[A] → [A,B] → [A]
 * → [A,B]` step 4's delta `(add=[B], remove=[])` matches step 2's verbatim.
 * Even adding the prior state doesn't help — the cycle returns to the same
 * prior state, same delta, same tag, CF rejects.
 *
 * Format: `m-<base36-millis>-<delta-hash>`
 *   - base36 timestamp guarantees lifetime uniqueness (CF deploys can't
 *     collide on the millisecond)
 *   - delta-hash suffix is for human debuggability — eyeballing "ah, that
 *     migration removed ClassFoo" is easier than reading raw timestamps
 *
 * Tests inject `now` so they can assert deterministic tag values; production
 * uses `Date.now()`.
 */
function migrationTag(
  addClasses: string[],
  removeClasses: string[],
  options?: ComputeDoMigrationOptions,
): string {
  const ts = (options?.now ?? Date.now()).toString(36)
  const delta = fnv1a32(
    JSON.stringify({ add: [...addClasses].sort(), remove: [...removeClasses].sort() }),
  )
  return `m-${ts}-${delta}`
}

function fnv1a32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
