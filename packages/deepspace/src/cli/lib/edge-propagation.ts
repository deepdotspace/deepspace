/**
 * The wait between "the platform accepted this release" and "the edge serves
 * it". Cloudflare propagates a script/asset update per colo, so both the
 * commands that publish a release — `deploy` and `rollback` — have to hold
 * before they claim a URL is live.
 *
 * What it can prove: the URL is answering as a deployed app, three polls in a
 * row, rather than the assets transitional page or the dispatch 404. What it
 * cannot prove: WHICH release is answering — nothing on the serving path is
 * version-stamped — so a caller that was already live gets convergence of the
 * app, not of the specific bundle. Stated here because the streak is the whole
 * guarantee, and it is easy to read it as stronger than it is.
 */

/** Cloudflare's transitional bodies, i.e. "accepted, not yet serving". */
const NOT_SERVING = ['Assets have not yet deployed', 'No app configured']

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
