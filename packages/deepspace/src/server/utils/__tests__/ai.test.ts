import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
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

/** The proxy fetch createDeepSpaceAI hands to the (mocked) provider. */
function proxyFetchFor(...args: Parameters<typeof createDeepSpaceAI>): typeof globalThis.fetch {
  createDeepSpaceAI(...args)
  const create = args[1] === 'anthropic' ? createAnthropic : createOpenAI
  return (vi.mocked(create).mock.calls.at(-1)![0] as { fetch: typeof globalThis.fetch }).fetch
}

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

  it('routes through the API worker with the proxy auth and leaves the Anthropic body alone', async () => {
    const anthropic = proxyFetchFor(
      { API_WORKER_URL: 'https://api.example.com', APP_OWNER_JWT: 'owner-jwt' },
      'anthropic',
    )
    const body = JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8192, messages: [{ role: 'user', content: 'hi' }] })

    await anthropic('https://api-worker.internal/api/proxy/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'platform-managed' },
      body,
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.example.com/api/proxy/anthropic/v1/messages')
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get('X-Auth-Token')).toBe('owner-jwt')
    expect(headers.has('x-api-key')).toBe(false)
    expect(init.body).toBe(body)
  })

  describe('OpenAI tool calls on models that need reasoning_effort none', () => {
    const TOOLS = [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: {} } } }]
    const send = async (payload: Record<string, unknown>) => {
      const openai = proxyFetchFor(
        { API_WORKER_URL: 'https://api.example.com', APP_OWNER_JWT: 'owner-jwt' },
        'openai',
      )
      await openai('https://api-worker.internal/api/proxy/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '999' },
        body: JSON.stringify({ messages: [], ...payload }),
      })
      const init = fetchSpy.mock.calls.at(-1)![1] as RequestInit
      return { body: JSON.parse(String(init.body)), headers: new Headers(init.headers) }
    }

    it.each(['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-6-sol-2026-09-01'])('adds it for %s with tools and no effort', async (model) => {
      const { body, headers } = await send({ model, tools: TOOLS })
      expect(body.reasoning_effort).toBe('none')
      expect(headers.has('content-length')).toBe(false)
    })

    it.each([
      ['an explicit effort', { model: 'gpt-6-sol', tools: TOOLS, reasoning_effort: 'high' }, 'high'],
      ['no tools', { model: 'gpt-6-sol' }, undefined],
      ['GPT-6 Astra, which rejects none', { model: 'gpt-6-astra', tools: TOOLS }, undefined],
      ['an older model', { model: 'gpt-5.4-mini', tools: TOOLS }, undefined],
    ])('leaves the request alone with %s', async (_case, payload, effort) => {
      const { body } = await send(payload)
      expect(body.reasoning_effort).toBe(effort)
    })
  })

  it('sends app identity and the sandbox scope, never smuggled caller values', async () => {
    const anthropic = proxyFetchFor(
      {
        API_WORKER_URL: 'https://api.example.com',
        APP_OWNER_JWT: 'owner-jwt',
        DEEPSPACE_APP_ID: 'app_01KZ707G1PSW064VMBAM7NW1AQ',
        APP_IDENTITY_TOKEN: 'identity-token',
      },
      'anthropic',
      { sandboxScope: 'app' },
    )

    await anthropic('https://api-worker.internal/api/proxy/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'x-app-id': 'app_forged', 'x-deepspace-sandbox-scope': 'user' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [] }),
    })

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers)
    expect(headers.get('x-app-id')).toBe('app_01KZ707G1PSW064VMBAM7NW1AQ')
    expect(headers.get('x-app-identity-token')).toBe('identity-token')
    expect(headers.get('x-deepspace-sandbox-scope')).toBe('app')
  })

  it('sends no identity before the first deploy has minted a token', async () => {
    const anthropic = proxyFetchFor(
      { API_WORKER_URL: 'https://api.example.com', APP_OWNER_JWT: 'owner-jwt', DEEPSPACE_APP_ID: 'app_x' },
      'anthropic',
    )

    await anthropic('https://api-worker.internal/api/proxy/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'x-app-id': 'app_forged', 'x-app-identity-token': 'forged' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 10, messages: [] }),
    })

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers)
    expect(headers.has('x-app-id')).toBe(false)
    expect(headers.has('x-app-identity-token')).toBe(false)
    expect(headers.get('x-deepspace-sandbox-scope')).toBe('user')
  })
})
