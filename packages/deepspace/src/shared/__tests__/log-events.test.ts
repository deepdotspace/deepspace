import { describe, expect, it } from 'vitest'
import {
  APP_LOG_EVENT_KEYS,
  LOG_LEVELS,
  loggableError,
  logEventText,
  MAX_LOG_TEXT_LENGTH,
  type AppLogEvent,
} from '../log-events'

describe('log-events shared contract', () => {
  it('enumerates exactly the whitelisted event keys', () => {
    // The e2e whitelist mirrors this set. A compile-time guard in the module
    // keeps this tuple ≡ keyof AppLogEvent.
    expect([...APP_LOG_EVENT_KEYS].sort()).toEqual(
      [
        'exception',
        'eventType',
        'id',
        'level',
        'message',
        'outcome',
        'request',
        'timestamp',
      ].sort(),
    )
  })

  it('exposes the canonical level set', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'log', 'info', 'warn', 'error'])
  })
})

describe('logEventText', () => {
  // This wording is the CLI's rendered line body AND the dashboard's search
  // corpus — a change here alters `deepspace logs` output, so pin it exactly.
  const base = {
    id: 'evt-1',
    timestamp: 1_783_970_000_000,
    level: 'info',
    message: 'fallback message',
  } as const

  it('renders an exception with its request location', () => {
    const event: AppLogEvent = {
      ...base,
      eventType: 'exception',
      exception: { name: 'TypeError', message: 'boom', stack: 'at x' },
      request: { method: 'POST', path: '/api/x', status: 500 },
    }
    expect(logEventText(event)).toBe('TypeError: boom — POST /api/x')
  })

  it('renders a request with status and non-ok outcome', () => {
    const event: AppLogEvent = {
      ...base,
      eventType: 'request',
      outcome: 'canceled',
      request: { method: 'GET', path: '/api/y', status: 200 },
    }
    expect(logEventText(event)).toBe('GET /api/y 200 (canceled)')
    expect(logEventText({ ...event, outcome: 'ok' })).toBe('GET /api/y 200')
    expect(
      logEventText({ ...event, outcome: 'ok', request: { method: 'GET', path: '/api/y' } }),
    ).toBe('GET /api/y')
  })

  it('falls back to the message for plain logs and malformed events', () => {
    expect(logEventText({ ...base, eventType: 'log' })).toBe('fallback message')
    // A mistyped event (the discriminant without its payload) must degrade to
    // the message, never crash or emit "undefined".
    expect(logEventText({ ...base, eventType: 'exception' })).toBe('fallback message')
    expect(logEventText({ ...base, eventType: 'request' })).toBe('fallback message')
  })
})

describe('loggableError', () => {
  it('keeps the message as the first line via the stack string', () => {
    const err = new Error('boom 42')
    const text = loggableError(err)
    expect(text.startsWith('Error: boom 42')).toBe(true)
    expect(text).toContain('    at ')
  })

  it('falls back to name: message when the runtime supplies no stack', () => {
    const err = new Error('quiet')
    err.stack = undefined
    expect(loggableError(err)).toBe('Error: quiet')
  })

  it('falls back to name: message when the runtime supplies an EMPTY stack', () => {
    const err = new Error('quiet')
    err.stack = ''
    expect(loggableError(err)).toBe('Error: quiet')
  })

  it('prepends the header to frames-only (non-V8) stacks', () => {
    const err = new Error('gecko boom')
    err.stack = 'handler@app.js:1:1\nrun@app.js:9:9'
    expect(loggableError(err)).toBe('Error: gecko boom\nhandler@app.js:1:1\nrun@app.js:9:9')
  })

  it('never throws, even on null-prototype throwables', () => {
    expect(loggableError(Object.create(null))).toBe('[object Object]')
  })

  it('prepends the header even when the message collides with a frame substring', () => {
    // The predicate is first-line/prefix, not substring: message "app.js"
    // appearing inside a Gecko frame must not read as "header present".
    const err = new Error('app.js')
    err.stack = 'handler@app.js:1:1\nrun@app.js:9:9'
    expect(loggableError(err)).toBe('Error: app.js\nhandler@app.js:1:1\nrun@app.js:9:9')
  })

  it('keeps an empty-message stack as-is', () => {
    const err = new Error('')
    err.stack = 'Error\n    at boom (app.js:1:1)'
    expect(loggableError(err)).toBe('Error\n    at boom (app.js:1:1)')
  })

  it('keeps the NAME on an empty-message, frames-only stack', () => {
    // The prefix test compares against the bare name when the message is
    // empty — a frames-only stack must still gain the name header rather
    // than render as anonymous frames.
    const err = new TypeError('')
    err.stack = 'handler@app.js:1:1\nrun@app.js:9:9'
    expect(loggableError(err)).toBe('TypeError\nhandler@app.js:1:1\nrun@app.js:9:9')
  })

  it('walks the cause chain — the only actionable text often lives there', () => {
    const cause = new Error('getaddrinfo ENOTFOUND api.example')
    cause.stack = undefined
    const err = new TypeError('fetch failed', { cause })
    err.stack = 'TypeError: fetch failed\n    at fetch (native)'
    expect(loggableError(err)).toBe(
      'TypeError: fetch failed\n    at fetch (native)\ncaused by: Error: getaddrinfo ENOTFOUND api.example',
    )
  })

  it('bounds the cause walk against cycles, and says so', () => {
    const a = new Error('a')
    a.stack = undefined
    a.cause = a
    expect(loggableError(a)).toBe(
      'Error: a' + '\ncaused by: Error: a'.repeat(4) + '\n… [cause chain truncated]',
    )
  })

  it('caps the rendered text AT the shared write-side budget — content survives up to it', () => {
    // Error text is often request-derived; without the cap a visitor could
    // balloon platform log ingestion to megabytes per console.error. The cap
    // is exact (marker included) so the reader never re-truncates a capped
    // write — and the budget is the IMPORTED constant, so shrinking it
    // without meaning to fails here.
    const err = new Error('x'.repeat(1024 * 1024))
    const out = loggableError(err)
    expect(out.length).toBe(MAX_LOG_TEXT_LENGTH)
    expect(out.startsWith('Error: xxxx')).toBe(true)
    expect(out.endsWith('… [truncated]')).toBe(true)
    expect(MAX_LOG_TEXT_LENGTH).toBe(8 * 1024)
  })

  it('a hostile NODE degrades in place — the actionable message above it survives', () => {
    // The whole point: one unrenderable cause must not discard the render.
    const err = new Error('DB connection refused')
    err.stack = undefined
    err.cause = Object.create(null)
    const out = loggableError(err)
    expect(out.startsWith('Error: DB connection refused')).toBe(true)
    expect(out).toContain('caused by: [object Object]')

    const trapped = new Error('outer message survives')
    trapped.stack = undefined
    Object.defineProperty(trapped, 'cause', {
      get() {
        throw new Error('trap')
      },
    })
    const out2 = loggableError(trapped)
    expect(out2.startsWith('Error: outer message survives')).toBe(true)
    expect(out2).toContain('… [cause chain unrenderable]')
  })

  it('a revoked-Proxy NODE degrades in place — its siblings still render', () => {
    // `instanceof` itself throws on a revoked Proxy; unguarded it would
    // unwind into the parent's catch and take the remaining AggregateError
    // siblings with it instead of tagging just the bad node.
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const agg = new AggregateError([new Error('one'), revoked.proxy, new Error('three')], 'batch')
    const out = loggableError(agg)
    expect(out).toContain('caused by: Error: one')
    expect(out).toContain('caused by: Error: three')
    expect(out).not.toContain('cause chain unrenderable')
  })

  it('budget exhaustion mid-chain leaves a marker even at the exact boundary', () => {
    // A node landing out at EXACTLY the budget used to return bare — the
    // top-level marker fires only ABOVE it, so the dropped chain vanished
    // silently. Any over-budget render must end in some marker.
    const err = new Error('x'.repeat(2 * MAX_LOG_TEXT_LENGTH), {
      cause: new Error('the-buried-cause'),
    })
    const out = loggableError(err)
    expect(out.length).toBe(MAX_LOG_TEXT_LENGTH)
    expect(out.endsWith('… [truncated]')).toBe(true)
  })

  it('the cap never leaves a lone surrogate at the cut', () => {
    const emoji = '😀'.repeat(MAX_LOG_TEXT_LENGTH)
    const out = loggableError(new Error(emoji))
    // Lib-safe well-formedness check (String.isWellFormed needs es2024):
    // no high surrogate without a low partner, and no orphan low surrogate.
    expect(out).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    )
    expect(out.endsWith('… [truncated]')).toBe(true)
  })

  it('a revoked Proxy cannot make the helper throw', () => {
    const { proxy, revoke } = Proxy.revocable(new Error('boom'), {})
    revoke()
    expect(() => loggableError(proxy)).not.toThrow()
    expect(loggableError(proxy)).toBe('[unloggable error]')
  })

  it("renders AggregateError's underlying reasons", () => {
    const agg = new AggregateError([new Error('one'), new Error('two')], 'all failed')
    agg.stack = undefined
    for (const sub of agg.errors as Error[]) sub.stack = undefined
    expect(loggableError(agg)).toBe(
      'AggregateError: all failed\ncaused by: Error: one\ncaused by: Error: two',
    )
  })

  it('never throws on hostile getters — degrades to a bare tag', () => {
    const hostile = new Error('boom')
    Object.defineProperty(hostile, 'stack', {
      get() {
        throw new Error('gotcha')
      },
    })
    expect(loggableError(hostile)).toBe('[object Error]')
  })

  it('treats a non-string stack as absent and skips a null cause', () => {
    const err = new Error('odd') as Error & { stack: unknown }
    ;(err as { stack: unknown }).stack = 42
    err.cause = null
    expect(loggableError(err)).toBe('Error: odd')
  })

  it('stringifies non-Error throwables', () => {
    expect(loggableError('plain string')).toBe('plain string')
    expect(loggableError(42)).toBe('42')
  })
})
