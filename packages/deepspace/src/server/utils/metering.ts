/**
 * Per-binding usage metering — record Vectorize / Workers AI / etc. costs
 * to the auto-attached `USAGE_EVENTS` Analytics Engine dataset.
 *
 * Why: the platform's tail-worker captures per-invocation compute (CPU + wall
 * time + script name) but it can't see which model an AI call hit, how many
 * tokens it embedded, or how many vectors a Vectorize query scanned. Without
 * those signals there's no way to surface per-tenant binding cost on the
 * billing dashboard.
 *
 * The deploy-worker auto-attaches a `USAGE_EVENTS` AE binding to every app
 * (dataset: `deepspace_binding_usage`). Apps don't need to declare it. They
 * just call `meterAi(...)` / `meterVectorize(...)` / `meterUsage(...)` after
 * each call and the dashboard rolls it up by `ownerUserId`.
 *
 * Schema written:
 *   indexes: [ownerUserId]
 *   blobs:   [appName, kind, model_or_index, op]
 *   doubles: [units, count]
 *
 * Use:
 *   await meterAi(env, '@cf/qwen/qwen3-embedding-0.6b', { inputChars: 5000 })
 *   await meterVectorize(env, 'unison-candidates', 'query', { vectors: 1000 })
 *   await meterUsage(env, 'custom-thing', { units: 1 })
 */
/// <reference types="@cloudflare/workers-types" />

interface MeteringEnv {
  USAGE_EVENTS?: AnalyticsEngineDataset
  OWNER_USER_ID?: string
  APP_NAME?: string
}

/**
 * Generic event recorder. Returns `false` if the binding isn't present
 * (dev / not yet deployed) or if AnalyticsEngine throws — metering must
 * never break the calling code path.
 */
export function meterUsage(
  env: MeteringEnv,
  kind: string,
  fields: { id?: string; op?: string; units?: number; count?: number } = {},
): boolean {
  const ds = env.USAGE_EVENTS
  if (!ds) return false
  try {
    ds.writeDataPoint({
      indexes: [env.OWNER_USER_ID ?? 'unknown'],
      blobs: [env.APP_NAME ?? 'unknown', kind, fields.id ?? '', fields.op ?? ''],
      doubles: [fields.units ?? 0, fields.count ?? 0],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Record a Workers AI call.
 *
 * Cloudflare prices input and output tokens at different rates for LLMs
 * (output is typically more expensive); embedding models bill input only.
 * Emits up to two events per call so the dashboard rollup can group by
 * `op` and apply the right per-token rate:
 *
 *   op='input'   units=inputChars
 *   op='output'  units=outputChars
 *
 * For a pure embedding call (outputChars=0), only the input event fires.
 * Pass `inputChars` and `outputChars` raw — the rough chars-to-token
 * conversion happens at price time using `COST_RATES.ai.embedInputPerChar`.
 *
 * Note: only embedding-input has an authoritative rate today. LLM-output
 * pricing varies wildly per model so `priceBindingUsageEvent` returns 0
 * for `op='output'` until per-model rates are wired. The events are still
 * recorded so the dashboard can show that the calls happened.
 */
export function meterAi(
  env: MeteringEnv,
  model: string,
  fields: { inputChars?: number; outputChars?: number; calls?: number } = {},
): boolean {
  const calls = fields.calls ?? 1
  const inChars = fields.inputChars ?? 0
  const outChars = fields.outputChars ?? 0
  let ok = true
  if (inChars > 0) {
    ok = meterUsage(env, 'ai', { id: model, op: 'input', units: inChars, count: calls }) && ok
  }
  if (outChars > 0) {
    ok = meterUsage(env, 'ai', { id: model, op: 'output', units: outChars, count: calls }) && ok
  }
  // No tokens reported: still record the call so we can see the model was
  // invoked in dashboards. Useful for failed/empty responses.
  if (inChars === 0 && outChars === 0) {
    ok = meterUsage(env, 'ai', { id: model, op: 'call', units: 0, count: calls }) && ok
  }
  return ok
}

/**
 * Record a Vectorize operation.
 *
 * Cloudflare's published model (https://developers.cloudflare.com/vectorize/platform/pricing/):
 *
 *   "If you have 10,000 vectors with 384-dimensions in an index, and make
 *    100 queries against that index, your total queried vector dimensions
 *    would sum to 3.878 million ((10000 + 100) * 384)."
 *
 * So query billing is *additive* — `(stored + queries) * dims` summed
 * across the call, not per-query-multiplied-by-stored. Translating to a
 * per-call meter:
 *
 *   op='query':   units = (vectors + storedCount) * dims
 *                 Without `storedCount` we significantly undercount: a single
 *                 query against a 100K-vector index produces ~100K queried
 *                 dims, not just `dims`.
 *   op='upsert':  CF doesn't bill upserts directly; the chargeable delta is
 *                 the change to stored-vector-month. `units = vectors * dims`
 *                 approximates the per-call storage delta.
 *   op='delete' / 'getByIds':  recorded for observability; no direct cost.
 *
 * Edge case: querying an empty index gives `(1 + 0) * dims = dims`, which
 * matches CF's formula (the `+ queries` term is always added, even at 0
 * stored). If CF later changes that and an empty-index query bills 0,
 * adjust here — `metering` is the single place to update the math.
 */
export function meterVectorize(
  env: MeteringEnv,
  indexName: string,
  op: 'query' | 'upsert' | 'delete' | 'getByIds',
  fields: { vectors?: number; dims?: number; storedCount?: number } = {},
): boolean {
  const vectors = fields.vectors ?? 0
  const dims = fields.dims ?? 0
  const stored = fields.storedCount ?? 0
  const units = op === 'query' ? (vectors + stored) * dims : vectors * dims
  return meterUsage(env, 'vectorize', { id: indexName, op, units, count: vectors })
}

// ---- Cost estimates (USD) — see Cloudflare pricing as of 2026-05 ----

/** English avg; replace with a real tokenizer if accuracy matters. */
const CHARS_PER_TOKEN = 4

/** $0.012 per 1M input tokens (bge-m3 + qwen3-embedding-0.6b tier). */
const AI_EMBED_USD_PER_M_TOKENS = 0.012

/** $0.01 per 1M queried dimensions. */
const VECTORIZE_QUERIED_USD_PER_M_DIMS = 0.01

/** $0.05 per 100M stored dimensions per month. */
const VECTORIZE_STORED_USD_PER_100M_DIMS = 0.05

/**
 * Per-`units` USD multipliers, matched to the (`kind`, `op`) the meter
 * helpers above record. Dashboard rollup can multiply
 *
 *   SUM(_sample_interval * doubles[1])   -- units
 *
 * by these to surface $-figures without re-querying CF's billing API.
 */
export const COST_RATES = {
  ai: {
    /**
     * USD per character of *embedding input* (bge-m3 / qwen3-embedding tier).
     * Renamed from `perChar` to make explicit that this rate does NOT
     * apply to LLM-generation output — see `priceBindingUsageEvent`.
     */
    embedInputPerChar: AI_EMBED_USD_PER_M_TOKENS / 1_000_000 / CHARS_PER_TOKEN,
  },
  vectorize: {
    /** USD per queried dimension (per query, per stored vector compared). */
    queriedPerDim: VECTORIZE_QUERIED_USD_PER_M_DIMS / 1_000_000,
    /** USD per stored dimension per month. */
    storedPerDimPerMonth: VECTORIZE_STORED_USD_PER_100M_DIMS / 100_000_000,
  },
} as const

/**
 * Price a single rolled-up `deepspace_binding_usage` row. Lives next to
 * `COST_RATES` so the (kind, op) → rate mapping stays paired with the schema
 * the meter helpers write.
 *
 * Returns 0 for combinations without an authoritative per-unit rate; the row
 * still surfaces in dashboards for observability. Notable zeros:
 *   - `ai/output`: LLM-output prices vary per model and `meterAi` doesn't
 *     carry a model-family signal. Pricing it at the embedding rate would
 *     silently under-bill chat-LLM use.
 *   - `vectorize.storedPerDimPerMonth`: events are per-call deltas, not
 *     monthly snapshots, so a windowed SUM isn't meaningful here.
 */
export function priceBindingUsageEvent(
  kind: string,
  op: string,
  units: number,
): number {
  if (kind === 'ai' && op === 'input') {
    return units * COST_RATES.ai.embedInputPerChar
  }
  if (kind === 'vectorize' && op === 'query') {
    return units * COST_RATES.vectorize.queriedPerDim
  }
  return 0
}
