/**
 * Pure pieces of `deepspace logs`: the --since parser, the follow-mode
 * dedupe window, and the pretty formatter. The end-to-end path (deployed
 * app → platform endpoint → CLI output) is covered by
 * tests/e2e/tests/logs.spec.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import logs, {
  fatalFollowStatus,
  parseSince,
  SeenEvents,
  formatEvent,
  followInitialLimit,
  nextPollSince,
} from '../logs'
import * as apiModule from '../../lib/api'
import * as authModule from '../../auth'
import * as appTargetModule from '../../lib/app-target'
import * as appContext from '../../lib/app-context'
import { renderCliError } from '../../lib/cli-errors'

const NOW = new Date('2026-07-13T12:00:00.000Z').getTime()

describe('parseSince', () => {
  it('parses relative windows', () => {
    expect(parseSince('30s', NOW)).toBe(NOW - 30_000)
    expect(parseSince('15m', NOW)).toBe(NOW - 15 * 60_000)
    expect(parseSince('2h', NOW)).toBe(NOW - 2 * 3_600_000)
    expect(parseSince('7d', NOW)).toBe(NOW - 7 * 86_400_000)
    expect(parseSince(' 5m ', NOW)).toBe(NOW - 5 * 60_000)
  })

  it('parses ISO timestamps', () => {
    expect(parseSince('2026-07-13T11:00:00.000Z', NOW)).toBe(NOW - 3_600_000)
  })

  it('rejects garbage and beyond-retention windows', () => {
    expect(() => parseSince('yesterday', NOW)).toThrow(/Invalid --since/)
    expect(() => parseSince('15x', NOW)).toThrow(/Invalid --since/)
    expect(() => parseSince('8d', NOW)).toThrow(/7 days/)
    expect(() => parseSince('2026-07-01T00:00:00Z', NOW)).toThrow(/7 days/)
  })
})

function evt(id: string, over: Partial<Parameters<typeof formatEvent>[0]> = {}) {
  return {
    id,
    timestamp: NOW,
    level: 'log' as const,
    eventType: 'log' as const,
    message: `msg-${id}`,
    ...over,
  }
}

describe('SeenEvents', () => {
  it('drops events already seen across polls', () => {
    const seen = new SeenEvents()
    expect(seen.fresh([evt('a'), evt('b')]).map((e) => e.id)).toEqual(['a', 'b'])
    // Next poll re-fetches from the cursor timestamp inclusively.
    expect(seen.fresh([evt('b'), evt('c')]).map((e) => e.id)).toEqual(['c'])
    expect(seen.fresh([evt('a'), evt('c')])).toEqual([])
  })

  it('bounds its memory to the cap', () => {
    const seen = new SeenEvents(2)
    seen.fresh([evt('a'), evt('b'), evt('c')]) // a evicted
    expect(seen.fresh([evt('a')]).map((e) => e.id)).toEqual(['a'])
    expect(seen.fresh([evt('c')])).toEqual([]) // still within cap
  })
})

describe('follow-mode polling', () => {
  it('tails the max page by default but honors an explicit --limit', () => {
    // Bug: the first follow page used the default 100 while every later poll
    // used 500, so 100–500 events in the initial window were dropped.
    expect(followInitialLimit(undefined, 500)).toBe(500)
    expect(followInitialLimit(200, 500)).toBe(200)
  })

  it('re-scans a lag window before the cursor, floored at the window start', () => {
    // Bug: polling from exactly `cursor` permanently skipped a late-ingested,
    // earlier-stamped event once a later-stamped one advanced the cursor.
    const cursor = 1_000_000
    expect(nextPollSince(cursor, 0)).toBe(cursor - 90_000) // default 90s lag
    expect(nextPollSince(cursor, cursor - 10_000)).toBe(cursor - 10_000) // floor wins
    expect(nextPollSince(cursor, 0, 5_000)).toBe(cursor - 5_000) // explicit lag
  })
})

describe('formatEvent (color off)', () => {
  it('renders console lines with time and level', () => {
    const line = formatEvent(evt('x', { message: 'hello world' }), false, NOW)
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} LOG {3}hello world$/)
  })

  it('adds a date prefix for events from another day', () => {
    const yesterday = NOW - 86_400_000
    const line = formatEvent(evt('x', { timestamp: yesterday }), false, NOW)
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /)
  })

  it('renders request events as method/path/status', () => {
    const line = formatEvent(
      evt('x', {
        eventType: 'request',
        outcome: 'ok',
        request: { method: 'GET', path: '/api/items', status: 200 },
      }),
      false,
      NOW,
    )
    expect(line).toContain('REQ   GET /api/items 200')
    expect(line).not.toContain('(ok)') // ok is the quiet default
  })

  it('pins the request and exception line shapes end-to-end — nothing appended', () => {
    // Fully anchored: the body wording now comes from the shared logEventText
    // (also the dashboard's search corpus), so a dashboard-motivated tweak
    // there must fail HERE, not silently change `deepspace logs` output.
    const req = formatEvent(
      evt('x', {
        eventType: 'request',
        outcome: 'canceled',
        request: { method: 'GET', path: '/api/items', status: 200 },
      }),
      false,
      NOW,
    )
    expect(req).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} REQ {3}GET \/api\/items 200 \(canceled\)$/)

    const exc = formatEvent(
      evt('x', {
        eventType: 'exception',
        request: { method: 'POST', path: '/api/x' },
        exception: { name: 'TypeError', message: 'boom' },
      }),
      false,
      NOW,
    )
    expect(exc).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} ERROR TypeError: boom — POST \/api\/x$/)
  })

  it('surfaces non-ok outcomes on request events', () => {
    const line = formatEvent(
      evt('x', {
        eventType: 'request',
        outcome: 'exceededCpu',
        request: { method: 'GET', path: '/api/spin', status: 503 },
      }),
      false,
      NOW,
    )
    expect(line).toContain('(exceededCpu)')
  })

  it('renders exceptions with request context and an indented stack', () => {
    const line = formatEvent(
      evt('x', {
        eventType: 'exception',
        request: { method: 'POST', path: '/api/boom', status: 500 },
        exception: {
          name: 'TypeError',
          message: 'Boom',
          stack: 'TypeError: Boom\n    at handler (worker.ts:10:5)',
        },
      }),
      false,
      NOW,
    )
    expect(line).toContain('ERROR TypeError: Boom — POST /api/boom')
    expect(line).toContain('\n    at handler (worker.ts:10:5)')
  })

  it('keeps a frame-only CF stack (no "Name: message" header) intact', () => {
    // Cloudflare worker stacks are often a single frame with no header line;
    // the old slice(1) ate it, leaving no stack in the pretty output.
    const line = formatEvent(
      evt('x', {
        eventType: 'exception',
        request: { method: 'GET', path: '/api/boom-raw', status: 500 },
        exception: {
          name: 'Error',
          message: 'raw boom',
          stack: '    at Object.fetch (index.js:45240:63)',
        },
      }),
      false,
      NOW,
    )
    expect(line).toContain('ERROR Error: raw boom — GET /api/boom-raw')
    expect(line).toContain('at Object.fetch (index.js:45240:63)') // the sole frame survives
  })

  it('never drops a real stack frame, even when the header text differs from the message', () => {
    // Wrapped/renamed error: the stack's first line isn't the exception's own
    // "name: message", so the header heuristic can't confirm it. The safe
    // behavior is to keep every frame (guards against a regression back to an
    // unconditional slice(1) that would eat frames).
    const line = formatEvent(
      evt('x', {
        eventType: 'exception',
        exception: {
          name: 'Error',
          message: 'original cause',
          stack: 'WrappedError: something else\n    at a (x:1:1)\n    at b (y:2:2)',
        },
      }),
      false,
      NOW,
    )
    expect(line).toContain('at a (x:1:1)')
    expect(line).toContain('at b (y:2:2)')
  })
})

describe('fatalFollowStatus', () => {
  it('ends the tail on statuses a retry cannot fix, keeps polling on the rest', () => {
    // 400 = our own malformed request (used to retry forever at max backoff).
    for (const fatal of [400, 401, 403, 404]) expect(fatalFollowStatus(fatal)).toBe(true)
    // 429 is the route's own throttle asking for a retry; 5xx is transient.
    for (const retryable of [429, 500, 502, 503]) expect(fatalFollowStatus(retryable)).toBe(false)
  })
})

/**
 * The NDJSON discriminators. An empty stream is indistinguishable from a
 * crashed one without a record to read, so both modes emit one — and each
 * carries the facts the human surface carries, because a "machine mirror"
 * that knows less than the prose it mirrors is not one.
 */
describe('logs --json discriminator frames', () => {
  const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  async function runLogs(args: Record<string, unknown>, page: Record<string, unknown>) {
    const out: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk))
      return true
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'assertAppTargetResolvable').mockImplementation(() => {})
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(appTargetModule, 'listApps').mockResolvedValue([
      { appId: APP_ID, status: 'active', createdAt: 'x', deployedAt: 'y', name: null, url: null },
    ])
    // logs reads through the retrying variant when it has no abort signal, and
    // plain apiFetch when it does (follow polls) — stub both.
    vi.spyOn(apiModule, 'apiFetch').mockResolvedValue(page as never)
    vi.spyOn(apiModule, 'apiFetchReadWithRetry').mockResolvedValue(page as never)
    const command = logs as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { json: true, ...args } })
    stdoutSpy.mockRestore()
    return out
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  it('bounded mode emits a meta frame carrying appId and retentionDays', async () => {
    const records = await runLogs({}, { events: [], truncated: false })

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      type: 'meta',
      count: 0,
      appId: APP_ID,
      retentionDays: 7,
    })
    expect(records[0].window).toEqual(expect.any(String))
  })

  it('follow mode OPENS with a ready frame, before any event', async () => {
    // A tail on a quiet (or never-deployed) app otherwise emits zero bytes
    // forever, and an agent cannot tell "connected, nothing to report" from
    // "wedged". The frame is written before the first event and before the
    // poll loop; the loop is then ended through its own FATAL path (a token
    // refresh that fails is not retryable) rather than by raising SIGINT,
    // which vitest itself handles.
    const out: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      out.push(String(chunk))
      return true
    }) as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(authModule, 'ensureToken')
      .mockResolvedValueOnce('token')
      .mockRejectedValue(new Error('session expired'))
    vi.spyOn(appTargetModule, 'assertAppTargetResolvable').mockImplementation(() => {})
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(appTargetModule, 'listApps').mockResolvedValue([
      { appId: APP_ID, status: 'active', createdAt: 'x', deployedAt: 'y', name: null, url: null },
    ])
    const page = {
      events: [
        {
          id: 'e1',
          timestamp: NOW,
          level: 'log',
          eventType: 'log',
          message: 'hello',
          source: 'server',
        },
      ],
      truncated: false,
    }
    vi.spyOn(apiModule, 'apiFetch').mockResolvedValue(page as never)
    vi.spyOn(apiModule, 'apiFetchReadWithRetry').mockResolvedValue(page as never)

    const command = logs as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await expect(command.run({ args: { json: true, follow: true } })).rejects.toThrow(
      /session expired/,
    )
    stdoutSpy.mockRestore()

    const records = out
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(records[0]).toMatchObject({
      type: 'ready',
      appId: APP_ID,
      count: 1,
      retentionDays: 7,
    })
    // It precedes the event it announced.
    expect(records[1]).toMatchObject({ id: 'e1' })
  })
})

describe('logs on a never-deployed app', () => {
  const APP_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0123'
  let argv: string[]
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    process.exitCode = undefined
    process.argv = argv
  })

  async function run(args: Record<string, unknown>) {
    argv = process.argv
    process.argv = [...argv, '--json']
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const command = logs as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    // A plain citty command: cli.ts wraps it so escaped errors reach the
    // shared renderer — do the same here.
    await command.run({ args: { json: true, ...args } }).catch(renderCliError)
    return JSON.parse(lines[0]) as Record<string, unknown>
  }

  it('refuses app_not_deployed with a `deepspace deploy` action instead of "no logs in the last 15m"', async () => {
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('tok')
    vi.spyOn(appTargetModule, 'assertAppTargetResolvable').mockImplementation(() => {})
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(appTargetModule, 'listApps').mockResolvedValue([
      {
        appId: APP_ID,
        status: 'registered',
        createdAt: 'x',
        deployedAt: null,
        name: null,
        url: null,
      },
    ])
    vi.spyOn(appContext, 'findAppDir').mockReturnValue('/apps/demo')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await run({})).toMatchObject({
      ok: false,
      code: 'app_not_deployed',
      action: { cwd: '/apps/demo', argv: ['deepspace', 'deploy'] },
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('ships no action when the app came from --app (the deploy must run from its own checkout)', async () => {
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('tok')
    vi.spyOn(appTargetModule, 'assertAppTargetResolvable').mockImplementation(() => {})
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(appTargetModule, 'listApps').mockResolvedValue([
      {
        appId: APP_ID,
        status: 'registered',
        createdAt: 'x',
        deployedAt: null,
        name: null,
        url: null,
      },
    ])
    const out = await run({ app: APP_ID })
    expect(out).toMatchObject({ ok: false, code: 'app_not_deployed' })
    expect(out.action).toBeUndefined()
  })
})
