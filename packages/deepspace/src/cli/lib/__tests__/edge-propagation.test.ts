/**
 * The release wait, exercised over REAL sockets against a local server.
 *
 * Stubbing `fetch` is what hid the defect this module was rewritten to fix:
 * the old probe agreed with itself because every poll reused one connection,
 * and a stubbed transport cannot show that. Here each probe is a real request,
 * and the server answers per CONNECTION — so a test can model an edge that is
 * half-rolled-over, which is the situation that matters.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { RELEASE_STAMP_PATH, waitForLiveRelease } from '../edge-propagation'

let server: Server | null = null

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

/**
 * Start a server that answers each CONNECTION with a release drawn from
 * `answers`, cycling. One connection per request is what the probe does, so a
 * `['old', 'new']` cycle models a colo that is exactly half converged.
 */
async function startEdge(answers: string[]): Promise<{ url: string; requests: number }> {
  const state = { requests: 0 }
  server = createServer((req, res) => {
    const release = answers[state.requests % answers.length]
    state.requests++
    if (!req.url?.startsWith(RELEASE_STAMP_PATH)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ release }))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const port = (server!.address() as { port: number }).port
  return Object.defineProperty({ url: `http://127.0.0.1:${port}` } as { url: string; requests: number }, 'requests', {
    get: () => state.requests,
  })
}

describe('waitForLiveRelease', () => {
  it('confirms once independent connections agree on the new release', async () => {
    const edge = await startEdge(['new'])
    await expect(waitForLiveRelease(edge.url, 'new', 30_000)).resolves.toBe('confirmed')
    // Ten agreeing probes, each its own connection — not one probe ten times.
    expect(edge.requests).toBeGreaterThanOrEqual(10)
  })

  it('does NOT confirm while the edge is still half-serving the old release', async () => {
    // The exact production failure: alternate old/new per connection. The old
    // fetch-based probe passed this in three polls because it reused a socket.
    const edge = await startEdge(['old', 'new'])
    await expect(waitForLiveRelease(edge.url, 'new', 3_000)).resolves.toBe('unconfirmed')
  })

  // Backing off through the stale phase, then ten agreeing probes, takes
  // longer than vitest's default wall — which is the point of the design.
  it('confirms once a rolling edge finishes converging', { timeout: 20_000 }, async () => {
    // Old for the first few connections, then new forever.
    const answers = ['old', 'old', 'old', ...Array.from({ length: 40 }, () => 'new')]
    let index = 0
    server = createServer((req, res) => {
      const release = answers[Math.min(index++, answers.length - 1)]
      if (!req.url?.startsWith(RELEASE_STAMP_PATH)) return void res.writeHead(404).end()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ release }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server!.address() as { port: number }).port
    await expect(
      waitForLiveRelease(`http://127.0.0.1:${port}`, 'new', 30_000),
    ).resolves.toBe('confirmed')
  })

  it('reports unverifiable without a stamp instead of pretending to check', async () => {
    const edge = await startEdge(['new'])
    await expect(waitForLiveRelease(edge.url, undefined, 30_000)).resolves.toBe('unverifiable')
    // Nothing was probed: there is nothing to compare against.
    expect(edge.requests).toBe(0)
  })

  it('treats an unreachable origin as not-yet-serving, not as success', async () => {
    // Port 1 is reserved and refuses; the probe must not read that as a match.
    await expect(waitForLiveRelease('http://127.0.0.1:1', 'new', 1_500)).resolves.toBe(
      'unconfirmed',
    )
  })
})
