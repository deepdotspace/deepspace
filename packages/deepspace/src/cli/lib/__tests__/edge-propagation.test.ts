/**
 * The release-stamp probe: proves the edge serves THE release, not merely a
 * release. The legacy reachability probe stays as the no-stamp fallback.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RELEASE_STAMP_PATH,
  waitForLiveRelease,
  waitForReleaseStamp,
} from '../edge-propagation'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stampServer(answers: () => string | null): { probes: string[] } {
  const probes: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input))
      probes.push(url.pathname + url.search)
      const release = answers()
      if (url.pathname !== RELEASE_STAMP_PATH) return new Response('<html>app</html>')
      if (release === null) return new Response('not found', { status: 404 })
      return Response.json({ release })
    }),
  )
  return { probes }
}

describe('waitForReleaseStamp', () => {
  it('resolves once the edge answers with this release, three polls in a row', async () => {
    stampServer(() => 'stamp-new')
    await expect(waitForReleaseStamp('https://app.example', 'stamp-new', 30_000)).resolves.toBe(
      true,
    )
  })

  it(
    'keeps polling through the old version and pre-stamp 404s, then converges',
    async () => {
      // Rollover: a 404 (a pre-stamp version still serving), then the old
      // stamp once, then the new one — exactly what mixed colos look like.
      const answers = ['404', 'stamp-old', 'stamp-new', 'stamp-new', 'stamp-new']
      const { probes } = stampServer(() => {
        const next = answers.shift() ?? 'stamp-new'
        return next === '404' ? null : next
      })
      await expect(waitForReleaseStamp('https://app.example', 'stamp-new', 60_000)).resolves.toBe(
        true,
      )
      expect(probes.length).toBeGreaterThanOrEqual(5)
      // Every probe is cache-busted: the CDN must not answer for a version it
      // no longer runs.
      expect(probes.every((p) => p.includes('probe='))).toBe(true)
    },
    20_000,
  )

  it('reports false when the deadline passes without convergence', async () => {
    stampServer(() => 'stamp-old')
    await expect(waitForReleaseStamp('https://app.example', 'stamp-new', 1)).resolves.toBe(false)
  })
})

describe('waitForLiveRelease', () => {
  it('uses the stamp when the platform sent one', async () => {
    const { probes } = stampServer(() => 'stamp-x')
    await expect(waitForLiveRelease('https://app.example', 'stamp-x', 30_000)).resolves.toBe(true)
    expect(probes.every((p) => p.startsWith(RELEASE_STAMP_PATH))).toBe(true)
  })

  it('falls back to the legacy reachability probe without one', async () => {
    const { probes } = stampServer(() => 'irrelevant')
    await expect(waitForLiveRelease('https://app.example', undefined, 30_000)).resolves.toBe(true)
    expect(probes.some((p) => p.startsWith(RELEASE_STAMP_PATH))).toBe(false)
  })
})
