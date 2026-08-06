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

  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let streak = 0

  while (Date.now() < deadline) {
    attempt++
    // Unique per probe: the stamp is a static asset, and a cached copy would
    // report the release it was cached under.
    const probe = new URL(RELEASE_STAMP_PATH, url)
    probe.searchParams.set('probe', `${Date.now()}-${attempt}`)

    if (await servesRelease(probe, releaseStamp)) {
      streak++
      if (streak >= CONSECUTIVE_MATCHES) return 'confirmed'
      await sleep(MATCH_INTERVAL_MS)
      continue
    }

    // Old stamp, transitional page, connection error: all "not yet".
    streak = 0
    await sleep(Math.min(4_000, 500 * 2 ** Math.min(attempt - 1, 3)))
  }
  return 'unconfirmed'
}

/** One probe, on a connection of its own. */
async function servesRelease(probe: URL, releaseStamp: string): Promise<boolean> {
  const body = await getOnFreshConnection(probe)
  if (body === null) return false
  try {
    return (JSON.parse(body) as { release?: unknown }).release === releaseStamp
  } catch {
    return false
  }
}

/** GET with pooling defeated: `agent: false` opens a socket of its own. */
function getOnFreshConnection(url: URL, timeoutMs = 5_000): Promise<string | null> {
  const send = url.protocol === 'http:' ? httpRequest : httpsRequest
  return new Promise((resolve) => {
    const request = send(
      url,
      { method: 'GET', agent: false, timeout: timeoutMs, headers: { 'cache-control': 'no-cache' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          resolve(null)
          return
        }
        let body = ''
        response.setEncoding('utf8')
        // A few dozen bytes; anything larger is not the stamp.
        response.on('data', (chunk: string) => {
          if (body.length < 4096) body += chunk
        })
        response.on('end', () => resolve(body))
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
