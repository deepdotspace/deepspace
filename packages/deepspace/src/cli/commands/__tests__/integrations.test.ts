/**
 * INT-1 (per-token pricing label) and FEAT-13 (paid-invoke confirmation gate).
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import type { CommandDef } from 'citty'
import integrations, {
  billingUnit,
  costGate,
  exampleBody,
  isInteractive,
  priceLabel,
  runInvoke,
} from '../integrations'

describe('integrations command surface', () => {
  it('exposes list, info, and invoke as distinct canonical commands', () => {
    const subCommands = integrations.subCommands as Record<string, CommandDef>
    expect(Object.keys(subCommands)).toEqual(['list', 'info', 'invoke'])

    const invokeArgs = subCommands.invoke.args as Record<
      string,
      { type: string; required?: boolean }
    >
    expect(invokeArgs.target).toMatchObject({ type: 'positional', required: true })
    expect(invokeArgs).not.toHaveProperty('list')
    expect(invokeArgs).not.toHaveProperty('info')
  })
})

describe('billingUnit (INT-1)', () => {
  it('renders per_token as "per token", not "per call"', () => {
    expect(billingUnit('per_token')).toBe('per token')
  })
  it('renders per_call as "per call"', () => {
    expect(billingUnit('per_call')).toBe('per call')
  })
  it('renders an unknown per_* model generically', () => {
    expect(billingUnit('per_request')).toBe('per request')
    expect(billingUnit('per_1k_tokens')).toBe('per 1k tokens')
  })
  it('passes a non-per_ model through unchanged', () => {
    expect(billingUnit('flat')).toBe('flat')
  })
})

describe('priceLabel', () => {
  it('calls an input-dependent figure a base rate, not a floor', () => {
    expect(
      priceLabel({
        model: 'per_token',
        baseCost: 0.000052,
        currency: 'USD',
        variesWithInput: true,
      }),
    ).toBe('base $0.000052 per token (some inputs cost less or more)')
  })
})

describe('costGate (FEAT-13 — nothing paid is ever billed silently)', () => {
  const base = { json: false, interactive: true, baseCost: 0.01 as number | null }

  it('asks a person at an interactive terminal', () => {
    expect(costGate(base)).toBe('confirm')
  })
  it('refuses a piped / CI caller without --yes', () => {
    expect(costGate({ ...base, interactive: false })).toBe('refuse')
  })
  it('refuses --json (an agent) without --yes, even at a terminal', () => {
    expect(costGate({ ...base, json: true })).toBe('refuse')
  })
  it('treats a metered (null) price as paid — --yes skips the gate entirely', () => {
    expect(costGate({ ...base, baseCost: null, interactive: false })).toBe('refuse')
    expect(costGate({ ...base, baseCost: null, json: true })).toBe('refuse')
  })
  it('proceeds on a free endpoint (baseCost 0) without asking', () => {
    expect(costGate({ ...base, baseCost: 0, interactive: false })).toBe('proceed')
  })
})

describe('--body-file - streaming input', () => {
  function stubStdin(chunks: string[]): void {
    let index = 0
    const stream = new Readable({
      read() {
        setTimeout(() => this.push(index < chunks.length ? chunks[index++] : null), 1)
      },
    })
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream as unknown as typeof process.stdin)
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('distinguishes an empty producer from malformed JSON before any billed call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    stubStdin([])

    await expect(
      runInvoke({ target: 'stripe/charge', bodyFile: '-', json: true } as never),
    ).rejects.toMatchObject({ code: 'empty_input' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('waits for malformed content before reporting the JSON error', async () => {
    vi.stubGlobal('fetch', vi.fn())
    stubStdin(['{"a":', 'not-json}'])

    await expect(
      runInvoke({ target: 'stripe/charge', bodyFile: '-', json: true } as never),
    ).rejects.toMatchObject({ code: 'invalid_body_json' })
  })
})

describe('runInvoke refuses a paid call outside a terminal', () => {
  it('names the price and --yes, and never POSTs', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input))
      return Response.json({
        integrations: {
          wikipedia: [
            {
              endpoint: 'get-page-summary',
              billing: { model: 'per_request', baseCost: 0.001, currency: 'USD' },
              inputSchema: null,
              example: null,
            },
          ],
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      await expect(
        runInvoke({ target: 'wikipedia/get-page-summary', body: '{"title":"Cheese"}', json: true }),
      ).rejects.toMatchObject({
        code: 'cost_confirmation_required',
        message: expect.stringMatching(/\$0\.001 per request.*--yes/s),
      })
    } finally {
      vi.unstubAllGlobals()
      if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
    }
    // Only the catalog was read; the billed endpoint was never called.
    expect(calls.every((url) => !url.includes('/api/integrations/wikipedia/'))).toBe(true)
  })
})

describe('exampleBody (info never shows `{}` for an endpoint that rejects it)', () => {
  it('keeps the catalog example when it has fields', () => {
    expect(exampleBody({ example: { title: 'Cheese' }, inputSchema: null })).toEqual({
      title: 'Cheese',
    })
  })
  it('synthesizes required keys from the schema, preferring its own example/default/enum', () => {
    expect(
      exampleBody({
        example: {},
        inputSchema: {
          type: 'object',
          required: ['title', 'lang', 'mode', 'limit', 'exact'],
          properties: {
            title: { type: 'string' },
            lang: { type: 'string', default: 'en' },
            mode: { type: 'string', enum: ['summary', 'full'] },
            limit: { type: 'integer', example: 5 },
            exact: { type: 'boolean' },
          },
        },
      }),
    ).toEqual({ title: '<string>', lang: 'en', mode: 'summary', limit: 5, exact: false })
  })
  it('passes the catalog value through when the schema requires nothing', () => {
    expect(exampleBody({ example: null, inputSchema: { type: 'object' } })).toBeNull()
    expect(exampleBody({ example: {}, inputSchema: null })).toEqual({})
  })
})

describe('isInteractive (FEAT-13 — both streams must be a TTY)', () => {
  it('is interactive only when stdin AND stdout are TTYs', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true)
  })
  it('is NOT interactive when stdin is piped even if stdout is a terminal', () => {
    // The bug this guards: prompting here would hang forever waiting on stdin.
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false)
  })
  it('is NOT interactive when stdout is redirected', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false)
  })
  it('is NOT interactive when neither is a TTY (CI)', () => {
    expect(isInteractive({}, {})).toBe(false)
  })
})
