/**
 * The wait between "the platform accepted this release" and "the edge serves
 * it". Cloudflare propagates a script/asset update per colo, so both the
 * commands that publish a release — `deploy` and `rollback` — have to hold
 * before they claim a URL is live.
 *
 * Two probes, one contract ({@link waitForLiveRelease}):
 *
 * - With a `releaseStamp` from the platform, the wait proves WHICH release is
 *   answering: every upload carries a synthetic `/.well-known/deepspace/
 *   release.json` asset naming its version, served by the asset layer
 *   atomically with the version rollover — for every app ever deployed,
 *   including rollbacks of pre-stamp bundles, because the platform injects it
 *   at upload time.
 * - Without one (an older platform, or a resumed idempotent activation whose
 *   original upload is gone), the legacy probe proves only that the URL
 *   answers as a deployed app — convergence of the app, not of the specific
 *   bundle. The streak is that probe's whole guarantee; it is easy to read it
 *   as stronger than it is, which is why the stamp exists.
 */

/** Cloudflare's transitional bodies, i.e. "accepted, not yet serving". */
const NOT_SERVING = ['Assets have not yet deployed', 'No app configured']

/** Where every version serves its own stamp (platform-reserved namespace). */
export const RELEASE_STAMP_PATH = '/.well-known/deepspace/release.json'

/** Prove the release, or when the platform sent no stamp, prove the app. */
export async function waitForLiveRelease(
  url: string,
  releaseStamp: string | null | undefined,
  timeoutMs: number,
): Promise<boolean> {
  return releaseStamp
    ? waitForReleaseStamp(url, releaseStamp, timeoutMs)
    : waitForEdgePropagation(url, timeoutMs)
}

export async function waitForReleaseStamp(
  url: string,
  releaseStamp: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let streak = 0

  while (Date.now() < deadline) {
    attempt++
    try {
      // Cache-busted so the CDN cannot answer for a version it no longer runs;
      // convergence being measured is the version rollover itself.
      const probe = new URL(RELEASE_STAMP_PATH, url)
      probe.searchParams.set('probe', `${Date.now()}-${attempt}`)
      const response = await fetch(probe, { redirect: 'manual' })
      const body = (await response.json().catch(() => null)) as { release?: unknown } | null
      // Anything else — the old version's stamp, a pre-stamp version's 404 or
      // SPA shell, the transitional page — is the same answer: not this
      // release yet.
      if (response.ok && body?.release === releaseStamp) {
        streak++
        if (streak >= 3) return true
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        continue
      }
      streak = 0
    } catch {
      streak = 0
    }

    const waitMs = Math.min(8_000, 1_000 * 2 ** (attempt - 1))
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  return false
}

export async function waitForEdgePropagation(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let streak = 0

  while (Date.now() < deadline) {
    attempt++
    try {
      const response = await fetch(url, { redirect: 'manual' })
      const body = await response.text()
      if (!NOT_SERVING.some((marker) => body.includes(marker))) {
        streak++
        if (streak >= 3) return true
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        continue
      }
      streak = 0
    } catch {
      streak = 0
    }

    const waitMs = Math.min(8_000, 1_000 * 2 ** (attempt - 1))
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  return false
}
