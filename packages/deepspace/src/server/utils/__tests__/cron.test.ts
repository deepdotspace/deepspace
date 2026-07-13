import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCronContext } from '../cron'

// `RECORD_ROOMS` is only used by ctx.records.* — these tests exercise
// ctx.integrations.call(), so a stub that satisfies the type is enough.
const FAKE_RECORD_ROOMS = {
  idFromName: () => ({} as DurableObjectId),
  get: () => ({ fetch: async () => new Response('{}') }),
} as unknown as DurableObjectNamespace

describe('buildCronContext().integrations.call', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('POSTs to /api/integrations/<name>/<endpoint> with Bearer APP_OWNER_JWT and JSON body', async () => {
    const ctx = buildCronContext(
      {
        RECORD_ROOMS: FAKE_RECORD_ROOMS,
        API_WORKER_URL: 'https://api.example.com',
        APP_OWNER_JWT: 'owner-jwt-value',
      },
      'owner-user-id',
    )

    const data = await ctx.integrations.call('openai/chat-completion', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(data).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.example.com/api/integrations/openai/chat-completion')
    expect((init as RequestInit).method).toBe('POST')

    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('Authorization')).toBe('Bearer owner-jwt-value')
    expect(headers.get('Content-Type')).toBe('application/json')

    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    })
  })

  it('defaults params to {} when omitted', async () => {
    const ctx = buildCronContext(
      {
        RECORD_ROOMS: FAKE_RECORD_ROOMS,
        API_WORKER_URL: 'https://api.example.com',
        APP_OWNER_JWT: 'owner-jwt-value',
      },
      'owner-user-id',
    )

    await ctx.integrations.call('wikipedia/get-random-page')

    const [, init] = fetchSpy.mock.calls[0]
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({})
  })

  it('throws with the api-worker error message on { success: false } responses', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, error: 'insufficient_credits', message: 'Insufficient credits.' }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    )

    const ctx = buildCronContext(
      {
        RECORD_ROOMS: FAKE_RECORD_ROOMS,
        API_WORKER_URL: 'https://api.example.com',
        APP_OWNER_JWT: 'owner-jwt-value',
      },
      'owner-user-id',
    )

    await expect(ctx.integrations.call('openai/chat-completion', {})).rejects.toThrow(
      /openai\/chat-completion failed: Insufficient credits/,
    )
  })

  it('throws when APP_OWNER_JWT is missing', async () => {
    const ctx = buildCronContext(
      {
        RECORD_ROOMS: FAKE_RECORD_ROOMS,
        API_WORKER_URL: 'https://api.example.com',
      },
      'owner-user-id',
    )

    await expect(ctx.integrations.call('openai/chat-completion', {})).rejects.toThrow(
      /APP_OWNER_JWT/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws on non-OK responses even when the body is unparseable', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('upstream gateway error', { status: 502 }),
    )

    const ctx = buildCronContext(
      {
        RECORD_ROOMS: FAKE_RECORD_ROOMS,
        API_WORKER_URL: 'https://api.example.com',
        APP_OWNER_JWT: 'owner-jwt-value',
      },
      'owner-user-id',
    )

    await expect(ctx.integrations.call('openai/chat-completion', {})).rejects.toThrow(
      /openai\/chat-completion failed/,
    )
  })
})
