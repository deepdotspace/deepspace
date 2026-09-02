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

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { RELEASE_STAMP_PATH } from '../../shared/app-routing'

export { RELEASE_STAMP_PATH } from '../../shared/app-routing'

/** Ten in a row: at the 25% staleness measured mid-rollout, a ~5.6% chance of
 *  passing early, for a few seconds of extra polling. */
const CONSECUTIVE_MATCHES = 10

/** Gap between probes once they start agreeing — enough to land elsewhere. */
const MATCH_INTERVAL_MS = 250

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
): Promise<ReleaseWait> {
  if (!releaseStamp) return 'unverifiable'
  // Unique per probe: the stamp is a static asset, and a cached copy would
  // report the release it was cached under.
  return agreeingProbes(timeoutMs, async (attempt) =>
    servesRelease(bustedUrl(RELEASE_STAMP_PATH, url, attempt), releaseStamp),
  )
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
 * Upgrade header reaches the room namespace unauthenticated and a healthy
 * room answers 404 (constructing — and so warming — the DO); only a 5xx
 * means not ready. An app that removed the scaffold's realtime routes 404s
 * at its router instead, indistinguishable from healthy: the probe can only
 * fail safe.
 */
export async function waitForDataPlane(
  url: string,
  appId: string,
  timeoutMs: number,
): Promise<Exclude<ReleaseWait, 'unverifiable'>> {
  return agreeingProbes(timeoutMs, async (attempt) => {
    const result = await getOnFreshConnection(bustedUrl(`/ws/app:${appId}`, url, attempt))
    return result !== null && result.statusCode < 500
  })
}

/** The shared wait: several probes on independent connections must agree. */
async function agreeingProbes(
  timeoutMs: number,
  probe: (attempt: number) => Promise<boolean>,
): Promise<Exclude<ReleaseWait, 'unverifiable'>> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let streak = 0
  while (Date.now() < deadline) {
    attempt++
    if (await probe(attempt)) {
      streak++
      if (streak >= CONSECUTIVE_MATCHES) return 'confirmed'
      await sleep(MATCH_INTERVAL_MS)
      continue
    }
    // Old answer, transitional page, connection error: all "not yet".
    streak = 0
    await sleep(Math.min(4_000, 500 * 2 ** Math.min(attempt - 1, 3)))
  }
  return 'unconfirmed'
}

function bustedUrl(path: string, base: string, attempt: number): URL {
  const probe = new URL(path, base)
  probe.searchParams.set('probe', `${Date.now()}-${attempt}`)
  return probe
}

/** One probe, on a connection of its own. */
async function servesRelease(probe: URL, releaseStamp: string): Promise<boolean> {
  const result = await getOnFreshConnection(probe)
  if (result === null || result.statusCode !== 200) return false
  try {
    return (JSON.parse(result.body) as { release?: unknown }).release === releaseStamp
  } catch {
    return false
  }
}

/** GET with pooling defeated: `agent: false` opens a socket of its own.
 *  `null` means no HTTP answer at all (refused, timed out, torn down). */
function getOnFreshConnection(
  url: URL,
  timeoutMs = 5_000,
): Promise<{ statusCode: number; body: string } | null> {
  const send = url.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve) => {
    const request = send(
      url,
      { method: 'GET', agent: false, timeout: timeoutMs, headers: { 'cache-control': 'no-cache' } },
      (response) => {
        const statusCode = response.statusCode ?? 0
        let body = ''
        response.setEncoding('utf8')
        // A few dozen bytes; anything larger is not a probe answer.
        response.on('data', (chunk: string) => {
          if (body.length < 4096) body += chunk
        })
        response.on('end', () => resolve({ statusCode, body }))
        response.on('error', () => resolve(null))
      },
    )
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
    request.on('error', () => resolve(null))
    request.end()
  })
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
