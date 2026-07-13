import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeepSpaceAI } from '../ai'

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn((config: unknown) => config),
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((config: unknown) => config),
}))

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((config: unknown) => config),
}))

describe('createDeepSpaceAI', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchSpy = vi.fn(async (_url: string | Request, _init?: RequestInit) =>
      new Response('ok', { status: 200 }),
    )
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('injects the Anthropic default max_tokens when the caller omitted one', async () => {
    const anthropic = createDeepSpaceAI(
      { API_WORKER_URL: 'https://api.example.com', APP_OWNER_JWT: 'owner-jwt' },
      'anthropic',
    ) as unknown as { fetch: typeof globalThis.fetch }

    await anthropic.fetch('https://api-worker.internal/api/proxy/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '999',
        'x-api-key': 'platform-managed',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.com/api/proxy/anthropic/v1/messages')

    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('X-Auth-Token')).toBe('owner-jwt')
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.has('content-length')).toBe(false)

    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
    })
  })

  it('preserves an explicit Anthropic max_tokens value', async () => {
    const anthropic = createDeepSpaceAI(
      { API_WORKER_URL: 'https://api.example.com', APP_OWNER_JWT: 'owner-jwt' },
      'anthropic',
    ) as unknown as { fetch: typeof globalThis.fetch }

    await anthropic.fetch('https://api-worker.internal/api/proxy/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
    })
  })
})
