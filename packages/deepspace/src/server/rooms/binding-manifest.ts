/**
 * Binding Manifest — non-DO bindings declared by an app's wrangler.toml that
 * the deploy-worker should pass through to Cloudflare's WfP upload API.
 *
 * Apps don't export a `__BINDING_MANIFEST__`; the CLI extracts these from the
 * normalized vite/wrangler output config at deploy time. This file just owns
 * the types + validation so both sides (CLI client and deploy-worker server)
 * agree on the shape.
 */
/// <reference types="@cloudflare/workers-types" />

/**
 * A single non-DO binding the app declares. Mirrors CF's WfP binding API.
 *
 * Provisionable resources (d1, kv_namespace, vectorize, r2_bucket, queue) accept
 * the literal string `"auto"` in their ID field to request platform-side
 * provisioning at deploy time. When `"auto"` is used, the deploy-worker creates
 * the resource on the platform CF account, persists the resulting CF ID in the
 * app registry, and substitutes the real ID before forwarding to WfP. The
 * sentinel sticks around in this type because:
 *   1. `wrangler` parsing requires a non-empty string in the id field
 *   2. The CLI passes the unresolved manifest through to the deploy-worker
 *   3. The deploy-worker is the only side with CF API credentials
 *
 * Companion fields (`database_name`, `title`, `dimensions`, `metric`) are only
 * used when `"auto"` is set — they tell the provisioner how to create the
 * resource. After provisioning these fields are still present on the wire but
 * ignored by WfP.
 */
export type CustomBinding =
  | {
      type: 'vectorize'
      name: string
      /** Either a pre-existing index name or the literal `"auto"`. */
      index_name: string
      /** Required when `index_name === "auto"`. */
      dimensions?: number
      /** Required when `index_name === "auto"`. */
      metric?: 'cosine' | 'euclidean' | 'dot-product'
    }
  | { type: 'ai'; name: string }
  | {
      type: 'r2_bucket'
      name: string
      /** Either a pre-existing bucket name or the literal `"auto"`. */
      bucket_name: string
    }
  | {
      type: 'kv_namespace'
      name: string
      /** Either a pre-existing KV namespace ID or the literal `"auto"`. */
      namespace_id: string
      /** Required when `namespace_id === "auto"`. Human-readable namespace title. */
      title?: string
    }
  | {
      type: 'd1'
      name: string
      /** Either a pre-existing D1 database UUID or the literal `"auto"`. */
      id: string
      /** Required when `id === "auto"`. Human-readable database name. */
      database_name?: string
    }
  | {
      type: 'queue'
      name: string
      /** Either a pre-existing queue name or the literal `"auto"`. */
      queue_name: string
    }
  | { type: 'browser_rendering'; name: string }
  | { type: 'analytics_engine'; name: string; dataset?: string }
  | { type: 'hyperdrive'; name: string; id: string }

export type CustomBindingManifest = CustomBinding[]

/** Sentinel string in an ID field that requests platform-side provisioning. */
export const AUTO_PROVISION_SENTINEL = 'auto'

/** Binding types whose ID field accepts the `"auto"` sentinel for provisioning. */
export const AUTO_PROVISIONABLE_TYPES = new Set([
  'd1',
  'kv_namespace',
  'vectorize',
  'r2_bucket',
  'queue',
])

/** Vectorize metric values accepted by CF when creating an index. */
const VECTORIZE_METRICS = new Set(['cosine', 'euclidean', 'dot-product'])

/**
 * True if a binding has the `"auto"` sentinel in its primary ID field. Used by
 * the deploy-worker to decide which entries need provisioning and by the
 * validator to enforce companion-field requirements.
 */
export function isAutoProvision(b: CustomBinding): boolean {
  switch (b.type) {
    case 'd1':
      return b.id === AUTO_PROVISION_SENTINEL
    case 'kv_namespace':
      return b.namespace_id === AUTO_PROVISION_SENTINEL
    case 'vectorize':
      return b.index_name === AUTO_PROVISION_SENTINEL
    case 'r2_bucket':
      return b.bucket_name === AUTO_PROVISION_SENTINEL
    case 'queue':
      return b.queue_name === AUTO_PROVISION_SENTINEL
    default:
      return false
  }
}

/** Binding `type` values an app is allowed to declare. */
export const ALLOWED_BINDING_TYPES = new Set([
  'vectorize',
  'ai',
  'r2_bucket',
  'kv_namespace',
  'd1',
  'queue',
  'browser_rendering',
  'analytics_engine',
  'hyperdrive',
])

/**
 * Binding NAMES the SDK reserves on every app — apps may not redeclare them.
 *
 * Includes:
 *   - Static-asset + service bindings the platform sets up automatically.
 *   - SDK-managed env (auth, identity, owner JWT).
 *   - The auto-attached cost-tracking AE dataset (`USAGE_EVENTS`).
 *
 * DO binding names (RECORD_ROOMS, YJS_ROOMS, etc.) are NOT in this set
 * because they live in a separate manifest (`__DO_MANIFEST__`).
 */
export const RESERVED_BINDING_NAMES = new Set([
  'ASSETS',
  'PLATFORM_WORKER',
  'API_WORKER',
  'APP_NAME',
  'OWNER_USER_ID',
  'AUTH_JWT_PUBLIC_KEY',
  'AUTH_JWT_ISSUER',
  'AUTH_WORKER_URL',
  'APP_IDENTITY_TOKEN',
  'APP_OWNER_JWT',
  'USAGE_EVENTS',
])

/**
 * Per-binding validation error. `binding` is undefined for top-level
 * shape failures (e.g. manifest is not an array).
 */
export interface ValidationError {
  binding?: CustomBinding
  reason: string
}

/**
 * Validate a binding manifest. Returns errors; an empty array means valid.
 *
 * Used both client-side (CLI) for friendly fail-fast and server-side
 * (deploy-worker) as a security boundary — apps can't sneak in reserved
 * binding names by editing the wire format.
 */
export function validateBindingManifest(
  manifest: unknown,
): { valid: true; bindings: CustomBindingManifest } | { valid: false; errors: ValidationError[] } {
  if (!Array.isArray(manifest)) {
    return { valid: false, errors: [{ reason: 'Manifest must be an array' }] }
  }
  const errors: ValidationError[] = []
  const seenNames = new Set<string>()
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') {
      errors.push({ reason: `Entry must be an object (got ${entry === null ? 'null' : typeof entry})` })
      continue
    }
    const e = entry as Record<string, unknown>
    const type = e.type
    const name = e.name
    if (typeof type !== 'string' || !ALLOWED_BINDING_TYPES.has(type)) {
      errors.push({
        reason: `Disallowed binding type: ${typeof type === 'string' ? type : `(${typeof type})`}. Allowed: ${[...ALLOWED_BINDING_TYPES].sort().join(', ')}`,
      })
      continue
    }
    if (typeof name !== 'string' || !name) {
      errors.push({ reason: `Binding of type "${type}" missing 'name' (string)` })
      continue
    }
    if (RESERVED_BINDING_NAMES.has(name)) {
      errors.push({ reason: `Binding name "${name}" is reserved by the SDK` })
      continue
    }
    if (seenNames.has(name)) {
      errors.push({ reason: `Duplicate binding name "${name}"` })
      continue
    }
    seenNames.add(name)
    // Now safely typed: type is in ALLOWED_BINDING_TYPES + name is a string.
    const binding = entry as CustomBinding
    const fieldErr = requiredFieldError(binding)
    if (fieldErr) errors.push({ binding, reason: fieldErr })
  }
  if (errors.length) return { valid: false, errors }
  return { valid: true, bindings: manifest as CustomBindingManifest }
}

function requiredFieldError(b: CustomBinding): string | null {
  switch (b.type) {
    case 'vectorize': {
      if (!b.index_name) return `vectorize binding "${b.name}" missing index_name (or "auto")`
      if (b.index_name === AUTO_PROVISION_SENTINEL) {
        // Auto-provisioning needs the index shape upfront — CF requires both
        // dimensions and metric at index-create time.
        if (typeof b.dimensions !== 'number' || b.dimensions <= 0) {
          return `vectorize binding "${b.name}" with index_name="auto" requires "dimensions" (positive number)`
        }
        if (!b.metric || !VECTORIZE_METRICS.has(b.metric)) {
          return `vectorize binding "${b.name}" with index_name="auto" requires "metric" (one of: ${[...VECTORIZE_METRICS].join(', ')})`
        }
      }
      return null
    }
    case 'r2_bucket':
      return b.bucket_name ? null : `r2_bucket binding "${b.name}" missing bucket_name (or "auto")`
    case 'kv_namespace': {
      if (!b.namespace_id) return `kv_namespace binding "${b.name}" missing namespace_id (or "auto")`
      if (b.namespace_id === AUTO_PROVISION_SENTINEL && !b.title) {
        return `kv_namespace binding "${b.name}" with namespace_id="auto" requires "title"`
      }
      return null
    }
    case 'd1': {
      if (!b.id) return `d1 binding "${b.name}" missing id (or "auto")`
      if (b.id === AUTO_PROVISION_SENTINEL && !b.database_name) {
        return `d1 binding "${b.name}" with id="auto" requires "database_name"`
      }
      return null
    }
    case 'queue':
      return b.queue_name ? null : `queue binding "${b.name}" missing queue_name (or "auto")`
    case 'hyperdrive':
      // Hyperdrive auto-provisioning is out of scope for v1 (needs upstream
      // connection-string management). Only pre-existing IDs accepted.
      if (!b.id) return `hyperdrive binding "${b.name}" missing id`
      if (b.id === AUTO_PROVISION_SENTINEL) {
        return `hyperdrive binding "${b.name}": auto-provisioning not yet supported (provide a real id)`
      }
      return null
    case 'ai':
    case 'browser_rendering':
    case 'analytics_engine':
      return null // no required fields beyond `name`
    default: {
      // Exhaustiveness guard — adding a new variant without a case fails here.
      const _exhaustive: never = b
      void _exhaustive
      return null
    }
  }
}

/**
 * Convert vite/wrangler's normalized config (from `.wrangler/deploy/config.json`)
 * into a CustomBindingManifest.
 *
 * Vite normalizes wrangler.toml into object/array structures with shapes like
 * `{ ai: { binding: 'AI' } }`, `{ vectorize: [{ binding, index_name }] }`,
 * etc. We extract each known shape with explicit field plucks (no broad
 * `as` casts) and return a flat array.
 */
export function bindingManifestFromOutputConfig(
  outputConfig: Record<string, unknown>,
): CustomBindingManifest {
  const out: CustomBindingManifest = []

  // ai: single object
  const aiBinding = pluckString(outputConfig.ai, 'binding')
  if (aiBinding) out.push({ type: 'ai', name: aiBinding })

  // vectorize: array of { binding, index_name, dimensions?, metric? }
  // `dimensions` and `metric` are only required when index_name === "auto"
  // (auto-provisioning); the validator enforces that, so we just pluck both
  // here and let it decide.
  for (const v of asObjectArray(outputConfig.vectorize)) {
    const name = pluckString(v, 'binding')
    const index_name = pluckString(v, 'index_name')
    if (!name || !index_name) continue
    const dimensions = pluckNumber(v, 'dimensions')
    const metric = pluckString(v, 'metric')
    out.push({
      type: 'vectorize',
      name,
      index_name,
      ...(dimensions != null && { dimensions }),
      ...(metric && (metric === 'cosine' || metric === 'euclidean' || metric === 'dot-product') && { metric }),
    })
  }

  // r2_buckets: array of { binding, bucket_name }
  for (const r of asObjectArray(outputConfig.r2_buckets)) {
    const name = pluckString(r, 'binding')
    const bucket_name = pluckString(r, 'bucket_name')
    if (name && bucket_name) out.push({ type: 'r2_bucket', name, bucket_name })
  }

  // kv_namespaces: array of { binding, id, title? }
  // `title` is only required when id === "auto"; pluck both here and let
  // the validator enforce the dependency.
  for (const k of asObjectArray(outputConfig.kv_namespaces)) {
    const name = pluckString(k, 'binding')
    const namespace_id = pluckString(k, 'id')
    if (!name || !namespace_id) continue
    const title = pluckString(k, 'title')
    out.push({
      type: 'kv_namespace',
      name,
      namespace_id,
      ...(title && { title }),
    })
  }

  // d1_databases: array of { binding, database_id, database_name? }
  // `database_name` is only required when database_id === "auto"; pluck both
  // and let the validator enforce.
  for (const d of asObjectArray(outputConfig.d1_databases)) {
    const name = pluckString(d, 'binding')
    const id = pluckString(d, 'database_id')
    if (!name || !id) continue
    const database_name = pluckString(d, 'database_name')
    out.push({
      type: 'd1',
      name,
      id,
      ...(database_name && { database_name }),
    })
  }

  // queues.producers: array of { binding, queue }
  const queues = isObject(outputConfig.queues) ? outputConfig.queues : null
  for (const q of asObjectArray(queues?.producers)) {
    const name = pluckString(q, 'binding')
    const queue_name = pluckString(q, 'queue')
    if (name && queue_name) out.push({ type: 'queue', name, queue_name })
  }

  // browser: { binding } (Cloudflare names this `browser` not `browser_rendering`)
  const browserBinding = pluckString(outputConfig.browser, 'binding')
  if (browserBinding) out.push({ type: 'browser_rendering', name: browserBinding })

  // analytics_engine_datasets: array of { binding, dataset? }
  for (const a of asObjectArray(outputConfig.analytics_engine_datasets)) {
    const name = pluckString(a, 'binding')
    const dataset = pluckString(a, 'dataset')
    if (name) out.push({ type: 'analytics_engine', name, dataset: dataset ?? undefined })
  }

  // hyperdrive: array of { binding, id }
  for (const h of asObjectArray(outputConfig.hyperdrive)) {
    const name = pluckString(h, 'binding')
    const id = pluckString(h, 'id')
    if (name && id) out.push({ type: 'hyperdrive', name, id })
  }

  return out
}

// ---- internal helpers (no broad `as` casts) ----

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function pluckString(v: unknown, key: string): string | null {
  if (!isObject(v)) return null
  const val = v[key]
  return typeof val === 'string' && val.length > 0 ? val : null
}

function pluckNumber(v: unknown, key: string): number | null {
  if (!isObject(v)) return null
  const val = v[key]
  return typeof val === 'number' && Number.isFinite(val) ? val : null
}

function asObjectArray(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) return []
  return v.filter(isObject)
}
