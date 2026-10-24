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
import { createHash } from 'node:crypto'
import {
  RELEASE_STAMP_PATH,
  waitForDataPlane,
  waitForHostReleased,
  waitForLiveRelease,
} from '../edge-propagation'

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
  const releases = new WeakMap<object, string>()
  server = createServer((req, res) => {
    // Bind the release to the socket, so accidentally pooling probes cannot
    // simulate independent edge machines by incrementing a request counter.
    let release = releases.get(req.socket)
    if (release === undefined) {
      release = answers[state.requests % answers.length]
      releases.set(req.socket, release)
    }
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
  return Object.defineProperty(
    { url: `http://127.0.0.1:${port}` } as { url: string; requests: number },
    'requests',
    {
      get: () => state.requests,
    },
  )
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
    await expect(waitForLiveRelease(`http://127.0.0.1:${port}`, 'new', 30_000)).resolves.toBe(
      'confirmed',
    )
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

describe('release client assets', () => {
  const script = 'export const version = "new"'
  const style = 'body{color:blue}'
  const assets = [
    {
      path: '/assets/lazy.mjs',
      hash: createHash('sha256').update(script).digest('hex'),
      size: Buffer.byteLength(script),
    },
    {
      path: '/assets/index.css',
      hash: createHash('sha256').update(style).digest('hex'),
      size: Buffer.byteLength(style),
    },
  ]

  async function startAssets(
    answer: (path: string, request: number) => { status: number; body: string },
  ) {
    const counts = new Map<string, number>()
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      expect(url.searchParams.get('_deepspace_probe')).toBe('readiness')
      const count = (counts.get(url.pathname) ?? 0) + 1
      counts.set(url.pathname, count)
      if (url.pathname === RELEASE_STAMP_PATH) {
        res.writeHead(200).end(JSON.stringify({ release: 'new' }))
        return
      }
      const result = answer(url.pathname, count)
      res.writeHead(result.status).end(result.body)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, counts }
  }

  it('waits for lazy chunks and styles even when every marker already matches', async () => {
    const edge = await startAssets((path, request) =>
      request === 1
        ? { status: 404, body: '' }
        : { status: 200, body: path.endsWith('.css') ? style : script },
    )
    await expect(waitForLiveRelease(edge.url, 'new', 5000, assets)).resolves.toBe('confirmed')
    expect(edge.counts.get('/assets/lazy.mjs')).toBe(2)
    expect(edge.counts.get('/assets/index.css')).toBe(2)
  })

  it.each([
    [
      'missing CSS',
      (path: string) => ({ status: path.endsWith('.css') ? 404 : 200, body: script }),
    ],
    ['SPA HTML fallback', () => ({ status: 200, body: '<html>fallback</html>' })],
    [
      'same-sized wrong bytes',
      (path: string) => ({
        status: 200,
        body: path.endsWith('.css') ? style : script.replace('new', 'old'),
      }),
    ],
    ['oversized response', () => ({ status: 200, body: 'x'.repeat(100_000) })],
  ])('does not confirm %s behind a matching marker', async (_name, answer) => {
    const edge = await startAssets(answer)
    await expect(waitForLiveRelease(edge.url, 'new', 1000, assets)).resolves.toBe('unconfirmed')
    expect(edge.counts.get('/assets/lazy.mjs')).toBeGreaterThan(0)
    expect(edge.counts.get('/assets/index.css')).toBeGreaterThan(0)
  })
})

/** Per-connection status cycle, mirroring startEdge for the status-code waits. */
async function startStatusEdge(statuses: number[], body = ''): Promise<{ url: string }> {
  const state = { requests: 0 }
  server = createServer((_req, res) => {
    res.writeHead(statuses[state.requests % statuses.length]!).end(body)
    state.requests++
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const port = (server!.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}` }
}

describe('waitForHostReleased (the undeploy counterpart)', () => {
  it('confirms once independent connections agree the host answers 404', async () => {
    const edge = await startStatusEdge([404])
    await expect(waitForHostReleased(edge.url, 30_000)).resolves.toBe('confirmed')
  })

  it('does NOT confirm while some edge machines still serve the app', async () => {
    // The AX C2 failure mode: undeploy "succeeded" while the URL served 200.
    const edge = await startStatusEdge([200, 404])
    await expect(waitForHostReleased(edge.url, 3_000)).resolves.toBe('unconfirmed')
  })
})

describe('waitForDataPlane (post-deploy DO probe)', () => {
  it('confirms only an initialized acknowledgment from the intended app room', async () => {
    const edge = await startStatusEdge(
      [200],
      JSON.stringify({ ok: true, room: 'record', scopeId: 'app:app_x' }),
    )
    await expect(waitForDataPlane(edge.url, 'app_x', 30_000)).resolves.toBe('confirmed')
  })

  it('does NOT confirm while edges on the old script version answer 5xx', async () => {
    // The AX S3 failure mode: "Durable Object Namespace was deleted" 500s
    // after serving was already confirmed.
    const edge = await startStatusEdge(
      [500, 200],
      JSON.stringify({ ok: true, room: 'record', scopeId: 'app:app_x' }),
    )
    await expect(waitForDataPlane(edge.url, 'app_x', 3_000)).resolves.toBe('unconfirmed')
  })
})

it.each([[200, JSON.stringify({ ok: true, room: 'record', scopeId: 'app:other' })]])(
  'does not treat status %s with an unrelated response as data-plane readiness',
  async (status, body) => {
    const edge = await startStatusEdge([status], body)
    await expect(waitForDataPlane(edge.url, 'app_x', 100)).resolves.toBe('unconfirmed')
  },
)

it.each([
  [404, 'Not Found'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [200, '<html>SPA fallback</html>'],
  [200, '<html>' + 'Large raw app '.repeat(1000) + '</html>'],
  [200, JSON.stringify({ ok: true })],
])('reports unsupported data-plane probes immediately (HTTP %s)', async (status, body) => {
  const edge = await startStatusEdge([status], body)
  const started = Date.now()
  expect(await waitForDataPlane(edge.url, 'app_x', 30_000)).toBe('unverifiable')
  expect(Date.now() - started).toBeLessThan(1000)
})
