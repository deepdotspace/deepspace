/**
 * Pure pieces of `deepspace logs`: the --since parser, the follow-mode
 * dedupe window, and the pretty formatter. The end-to-end path (deployed
 * app → platform endpoint → CLI output) is covered by
 * tests/e2e/tests/logs.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { parseSince, SeenEvents, formatEvent, followInitialLimit, nextPollSince } from '../logs'

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

  it('prefixes a CLIENT tag on browser-forwarded errors', () => {
    // A client-sourced console line...
    const logLine = formatEvent(evt('x', { source: 'client', message: 'white screen' }), false, NOW)
    expect(logLine).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} CLIENT LOG {3}white screen$/)
    // ...and a client-sourced exception both carry the tag; a server one doesn't.
    const excLine = formatEvent(
      evt('y', {
        source: 'client',
        eventType: 'exception',
        exception: { name: 'TypeError', message: 'boom' },
      }),
      false,
      NOW,
    )
    expect(excLine).toContain('CLIENT ERROR TypeError: boom')
    expect(formatEvent(evt('z', { message: 'server side' }), false, NOW)).not.toContain('CLIENT')
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
