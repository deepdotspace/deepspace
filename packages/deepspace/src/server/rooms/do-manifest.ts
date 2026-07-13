/**
 * DO Manifest — Dynamic Durable Object binding declarations.
 *
 * Apps export a `__DO_MANIFEST__` array in their worker.ts.
 * The CLI extracts it and sends it to the deploy worker,
 * which uses it to generate dynamic CF API bindings and migrations.
 */

/// <reference types="@cloudflare/workers-types" />

export interface DOManifestEntry {
  /** CF binding name, e.g. 'RECORD_ROOMS' */
  binding: string
  /** Exported class name, e.g. 'AppRecordRoom' */
  className: string
  /** Whether this DO uses SQLite storage */
  sqlite: boolean
}

export type DOManifest = DOManifestEntry[]

/**
 * Utility type: auto-generates Env bindings from a manifest.
 *
 * @example
 * const manifest = [
 *   { binding: 'RECORD_ROOMS', className: 'AppRecordRoom', sqlite: true },
 *   { binding: 'GAME_ROOMS', className: 'AppGameRoom', sqlite: true },
 * ] as const satisfies DOManifest
 *
 * type Env = BaseEnv & DOBindings<typeof manifest>
 * // => { RECORD_ROOMS: DurableObjectNamespace; GAME_ROOMS: DurableObjectNamespace }
 */
export type DOBindings<T extends readonly DOManifestEntry[]> = {
  [K in T[number]['binding']]: DurableObjectNamespace
}

/** Default manifest for apps that don't declare one */
export const DEFAULT_DO_MANIFEST: DOManifest = [
  { binding: 'RECORD_ROOMS', className: 'AppRecordRoom', sqlite: true },
  { binding: 'YJS_ROOMS', className: 'AppYjsRoom', sqlite: true },
]

/**
 * Shape-validate a DO manifest received over the wire (e.g. from the CLI's
 * deploy form-field). Without this, malformed input gets passed straight to
 * `deployToWfP`'s `.filter(...).map(...)` chain and crashes the route mid-deploy.
 *
 * Mirrors the contract of `validateBindingManifest` for non-DO bindings.
 */
export function validateDoManifest(
  manifest: unknown,
): { valid: true; manifest: DOManifest } | { valid: false; reason: string } {
  if (!Array.isArray(manifest)) {
    return { valid: false, reason: 'doManifest must be an array' }
  }
  const seen = new Set<string>()
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') {
      return { valid: false, reason: `doManifest entry must be an object (got ${entry === null ? 'null' : typeof entry})` }
    }
    const e = entry as Record<string, unknown>
    if (typeof e.binding !== 'string' || !e.binding) {
      return { valid: false, reason: `doManifest entry missing 'binding' (string)` }
    }
    if (typeof e.className !== 'string' || !e.className) {
      return { valid: false, reason: `doManifest entry "${e.binding}" missing 'className' (string)` }
    }
    if (typeof e.sqlite !== 'boolean') {
      return { valid: false, reason: `doManifest entry "${e.binding}" 'sqlite' must be a boolean` }
    }
    if (seen.has(e.binding)) {
      return { valid: false, reason: `doManifest has duplicate binding "${e.binding}"` }
    }
    seen.add(e.binding)
  }
  return { valid: true, manifest: manifest as DOManifest }
}
