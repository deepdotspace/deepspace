/**
 * The wait between "the platform accepted this release" and "the edge serves
 * it", for `deploy` and `rollback`.
 *
 * Cloudflare rolls a version out per edge machine, so a colo answers from a
 * MIX right after a deploy. `fetch` keeps one connection alive, so a poll loop
 * re-interviews the machine that answered first and agrees with itself while a
 * quarter of visitors still get the old release. Each probe here opens its own
 * connection instead, and the wait needs several to agree.
 *
 * It proves the edge THIS MACHINE reaches serves the new release — not global
 * convergence, which no client can observe. Callers report that distinction.
 */

import { createHash } from 'node:crypto'
import { RELEASE_STAMP_PATH } from '../../shared/app-routing'

export { RELEASE_STAMP_PATH } from '../../shared/app-routing'

/** Ten in a row: at the 25% staleness measured mid-rollout, a ~5.6% chance of
 *  passing early. Concurrent requests keep high-latency agent proxies from
 *  turning the same sample count into a minute of sequential round trips. */
const CONSECUTIVE_MATCHES = 10
const PROBE_CONCURRENCY = 5

/** Gap between probes once they start agreeing — enough to land elsewhere. */
const MATCH_INTERVAL_MS = 250
const ASSET_CONCURRENCY = 8

export interface ReleaseAsset {
  path: string
  hash: string
  size: number
}

export type ReleaseWait =
  /** Independent connections agree: this edge serves the release just published. */
  | 'confirmed'
  /** The deadline passed with the edge still mixed. */
  | 'unconfirmed'
  /** The platform sent no stamp, so there is nothing to verify against. */
  | 'unverifiable'

/** A missing stamp is reported, not papered over: an older platform or a
 *  resumed activation cannot be verified from the client at all. */
export async function waitForLiveRelease(
  url: string,
  releaseStamp: string | null | undefined,
  timeoutMs: number,
  assets: readonly ReleaseAsset[] = [],
): Promise<ReleaseWait> {
  if (!releaseStamp) return 'unverifiable'
  const bundles = assets.filter((asset) => /\.(?:m?js|css)$/i.test(asset.path))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const markers = await agreeingProbes(
      deadline - Date.now(),
      (attempt, remaining) =>
        servesRelease(bustedUrl(RELEASE_STAMP_PATH, url, attempt), releaseStamp, remaining),
      PROBE_CONCURRENCY,
    )
    if (markers !== 'confirmed') return markers
    // A marker can reach the edge before a browser's new chunks do. Check the
    // actual upload bytes, including lazy chunks, on independent connections.
    // A 200 SPA fallback or an older same-path bundle must not count as ready.
    let next = 0
    let ready = true
    await Promise.all(
      Array.from({ length: Math.min(ASSET_CONCURRENCY, bundles.length) }, async () => {
        while (ready && next < bundles.length) {
          const asset = bundles[next++]!
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            ready = false
            break
          }
          const result = await getOnFreshConnection(
            bustedUrl(asset.path, url, next),
            Math.min(5_000, remaining),
            asset.size,
          )
          if (
            !result ||
            result.statusCode !== 200 ||
            result.size !== asset.size ||
            result.hash !== asset.hash
          )
            ready = false
        }
      }),
    )
    // Hash each bundle once per candidate release, not ten times. Bracket the
    // bytes with release-marker agreement so a rollout cannot swap underneath.
    if (
      ready &&
      Date.now() < deadline &&
      (await servesRelease(
        bustedUrl(RELEASE_STAMP_PATH, url, 0),
        releaseStamp,
        deadline - Date.now(),
      )) &&
      Date.now() < deadline
    )
      return 'confirmed'
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())))
  }
  return 'unconfirmed'
}

/**
 * The undeploy counterpart of {@link waitForLiveRelease}. Undeploy used to
 * return while the old URL kept serving 200 through route-table propagation
 * and edge caches, so "confirm the URL 404s" verified nothing in either
 * direction (AX C2, docs/audits/2026-09-01). Confirms once independent fresh
 * connections agree the host answers 404.
 */
export async function waitForHostReleased(
  url: string,
  timeoutMs: number,
): Promise<Exclude<ReleaseWait, 'unverifiable'>> {
  return agreeingProbes(timeoutMs, async (attempt) => {
    const result = await getOnFreshConnection(bustedUrl('/', url, attempt))
    return result !== null && result.statusCode === 404
  })
}

/**
 * Post-deploy data-plane probe (AX S3, docs/audits/2026-09-01). The release
 * stamp is a static asset that never enters the worker, so `serving:
 * "confirmed"` said nothing about whether the worker's Durable Object
 * bindings resolve — after an undeploy → redeploy, edge machines briefly on
 * the previous script version answer 500 "Durable Object Namespace was
 * deleted" for /api/actions/* and /ws/*. `GET /ws/app:<appId>` without an
 * Upgrade header reaches the room namespace unauthenticated. A readiness
 * request returns a small explicit acknowledgment after schema initialization.
 * Router or auth 4xx answers, redirects, HTML fallbacks, and older workers are
 * not confirmation.
 */
export async function waitForDataPlane(
  url: string,
  appId: string,
  timeoutMs: number,
): Promise<ReleaseWait> {
  const deadline = Date.now() + timeoutMs
  const probe = async (attempt: number, remaining: number): Promise<ReleaseWait> => {
    const result = await getOnFreshConnection(
      bustedUrl(`/ws/app:${appId}`, url, attempt),
      Math.min(5_000, remaining),
    )
    // A 4xx is the app's router or auth answering, not a stale edge.
    if (result && result.statusCode >= 400 && result.statusCode < 500) return 'unverifiable'
    if (!result || result.statusCode !== 200) return 'unconfirmed'
    try {
      const health = JSON.parse(result.body)
      if (health?.room !== 'record') return 'unverifiable'
      return health.ok === true && health.scopeId === `app:${appId}` ? 'confirmed' : 'unconfirmed'
    } catch {
      return 'unverifiable'
    }
  }
  // Raw Workers and older SDK apps have no RecordRoom readiness endpoint.
  // An unsupported response proves nothing, but waiting cannot verify it.
  if ((await probe(0, timeoutMs)) === 'unverifiable') return 'unverifiable'
  return agreeingProbes(
    Math.max(0, deadline - Date.now()),
    async (attempt, remaining) => (await probe(attempt, remaining)) === 'confirmed',
    PROBE_CONCURRENCY,
  )
}

/** The shared wait: several probes on independent connections must agree. */
async function agreeingProbes(
  timeoutMs: number,
  probe: (attempt: number, remaining: number) => Promise<boolean>,
  concurrency = 1,
): Promise<Exclude<ReleaseWait, 'unverifiable'>> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let streak = 0
  while (Date.now() < deadline) {
    const results = await Promise.all(
      Array.from({ length: Math.min(concurrency, CONSECUTIVE_MATCHES - streak) }, () =>
        probe(++attempt, Math.max(1, deadline - Date.now())),
      ),
    )
    if (results.every(Boolean)) {
      if (Date.now() >= deadline) return 'unconfirmed'
      streak += results.length
      if (streak >= CONSECUTIVE_MATCHES) return 'confirmed'
      await sleep(Math.min(MATCH_INTERVAL_MS, Math.max(0, deadline - Date.now())))
      continue
    }
    // Old answer, transitional page, connection error: all "not yet".
    streak = 0
    await sleep(
      Math.min(
        Math.max(0, deadline - Date.now()),
        4_000,
        500 * 2 ** Math.min(Math.ceil(attempt / concurrency) - 1, 3),
      ),
    )
  }
  return 'unconfirmed'
}

function bustedUrl(path: string, base: string, attempt: number): URL {
  const probe = new URL(path, base)
  probe.searchParams.set('_deepspace_probe', 'readiness')
  probe.searchParams.set('probe', `${Date.now()}-${attempt}`)
  return probe
}

/** One probe, on a connection of its own. */
async function servesRelease(
  probe: URL,
  releaseStamp: string,
  remaining = 5_000,
): Promise<boolean> {
  const result = await getOnFreshConnection(probe, Math.max(1, Math.min(5_000, remaining)))
  if (result === null || result.statusCode !== 200) return false
  try {
    return (JSON.parse(result.body) as { release?: unknown }).release === releaseStamp
  } catch {
    return false
  }
}

/** Keep the host's working fetch transport (including its proxy/dispatcher),
 *  but forbid socket reuse so probes do not repeatedly sample one edge machine.
 *  A custom Node Agent can bypass container egress even with proxyEnv enabled.
 *  `null` means no bounded, complete HTTP answer. */
async function getOnFreshConnection(
  url: URL,
  timeoutMs = 5_000,
  byteLimit = 4096,
): Promise<{ statusCode: number; body: string; size: number; hash: string } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        connection: 'close',
        'cache-control': 'no-cache',
        'accept-encoding': 'identity',
      },
      redirect: 'manual',
      // Covers both response headers and a body that keeps trickling bytes.
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body = ''
    let size = 0
    const hash = createHash('sha256')
    const reader = response.body?.getReader()
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > byteLimit) {
            await reader.cancel()
            // Keep the HTTP status so a large SPA fallback can be identified
            // as an unsupported probe. Never expose truncated bytes as valid.
            return { statusCode: response.status, body: '', size, hash: '' }
          }
          hash.update(value)
          if (body.length < 4096)
            body += Buffer.from(value.subarray(0, 4096 - body.length)).toString('utf8')
        }
      } finally {
        reader.releaseLock()
      }
    }
    return { statusCode: response.status, body, size, hash: hash.digest('hex') }
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wake the app's worker once the edge serves the release. The serving probe
 * reads a static asset (the release stamp), which never enters the worker —
 * and a Durable Object exists only once something fetches it, so a deployed
 * cron schedule would otherwise wait for its first visitor. `/api/auth/ok`
 * is the template's own health route (its tests use it), worker-first by
 * routing. Best effort: if this request fails, the first real request arms
 * the schedule instead, exactly as before.
 */
export async function wakeWorker(url: string): Promise<void> {
  try {
    await fetch(new URL('/api/auth/ok', url), { signal: AbortSignal.timeout(5_000) })
  } catch {
    // Nothing to report: the wake is a courtesy, not a contract.
  }
}
