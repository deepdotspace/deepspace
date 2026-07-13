/**
 * Upstream proxy helper tests.
 *
 * Each helper has three states we care about:
 *   1. Service binding present → calls `binding.fetch(...)`, never `globalThis.fetch`.
 *   2. Only URL configured     → calls `globalThis.fetch(BASE_URL + path)`.
 *   3. Neither configured      → throws an actionable Error.
 *
 * The auth-worker is URL-only; (1) doesn't apply.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  apiWorkerFetch,
  platformWorkerFetch,
  authWorkerFetch,
} from '../proxies'

function fakeFetcher() {
  const fetcher = {
    fetch: vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok', { status: 200 })),
  }
  return fetcher as unknown as Fetcher & { fetch: ReturnType<typeof vi.fn> }
}

describe('apiWorkerFetch', () => {
  let originalFetch: typeof globalThis.fetch
  let globalFetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalFetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('url-ok', { status: 200 }),
    )
    globalThis.fetch = globalFetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('uses the service binding when API_WORKER is present', async () => {
    const fetcher = fakeFetcher()
    const env = { API_WORKER: fetcher, API_WORKER_URL: 'https://should-not-be-used.example' }

    const res = await apiWorkerFetch(env, '/api/integrations')

    expect(res.status).toBe(200)
    expect(fetcher.fetch).toHaveBeenCalledTimes(1)
    expect(globalFetchSpy).not.toHaveBeenCalled()
    // Path-only inputs become https://api-worker/<path> for the binding (host is cosmetic).
    expect(fetcher.fetch.mock.calls[0][0]).toBe('https://api-worker/api/integrations')
  })

  it('falls back to URL fetch when only API_WORKER_URL is set', async () => {
    const env = { API_WORKER_URL: 'https://api.example.com' }

    const res = await apiWorkerFetch(env, '/api/integrations/status')

    expect(res.status).toBe(200)
    expect(globalFetchSpy).toHaveBeenCalledTimes(1)
    expect(globalFetchSpy.mock.calls[0][0]).toBe('https://api.example.com/api/integrations/status')
  })

  it('strips the host from full-URL inputs and uses the configured transport', async () => {
    const env = { API_WORKER_URL: 'https://api.example.com' }

    await apiWorkerFetch(env, 'https://api-worker/api/integrations?foo=bar')

    expect(globalFetchSpy.mock.calls[0][0]).toBe(
      'https://api.example.com/api/integrations?foo=bar',
    )
  })

  it('throws an actionable error when neither binding nor URL is configured', () => {
    expect(() => apiWorkerFetch({}, '/api/integrations')).toThrow(
      /API_WORKER.*API_WORKER_URL.*\.dev\.vars/s,
    )
  })

  it('trims a trailing slash from API_WORKER_URL', async () => {
    const env = { API_WORKER_URL: 'https://api.example.com/' }
    await apiWorkerFetch(env, '/api/integrations')
    expect(globalFetchSpy.mock.calls[0][0]).toBe('https://api.example.com/api/integrations')
  })

  it('forwards init verbatim to the binding fetcher', async () => {
    const fetcher = fakeFetcher()
    const env = { API_WORKER: fetcher }
    const init: RequestInit = {
      method: 'POST',
      headers: { 'X-Test': 'yes' },
      body: 'hello',
    }

    await apiWorkerFetch(env, '/api/integrations/foo/bar', init)

    expect(fetcher.fetch).toHaveBeenCalledWith(
      'https://api-worker/api/integrations/foo/bar',
      init,
    )
  })
})

describe('platformWorkerFetch', () => {
  let originalFetch: typeof globalThis.fetch
  let globalFetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalFetchSpy = vi.fn(async (_url: string | Request, _init?: RequestInit) =>
      new Response('url-ok', { status: 200 }),
    )
    globalThis.fetch = globalFetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('uses the service binding when PLATFORM_WORKER is present (string path)', async () => {
    const fetcher = fakeFetcher()
    const env = { PLATFORM_WORKER: fetcher, PLATFORM_WORKER_URL: 'https://platform.example' }

    await platformWorkerFetch(env, '/internal/files/list')

    expect(fetcher.fetch).toHaveBeenCalledTimes(1)
    expect(globalFetchSpy).not.toHaveBeenCalled()
    expect(fetcher.fetch.mock.calls[0][0]).toBe('https://platform-worker/internal/files/list')
  })

  it('falls back to URL fetch when only PLATFORM_WORKER_URL is set (string path)', async () => {
    const env = { PLATFORM_WORKER_URL: 'https://platform.example.com' }

    await platformWorkerFetch(env, '/internal/files/upload', { method: 'POST' })

    expect(globalFetchSpy).toHaveBeenCalledTimes(1)
    expect(globalFetchSpy.mock.calls[0][0]).toBe(
      'https://platform.example.com/internal/files/upload',
    )
    expect(globalFetchSpy.mock.calls[0][1]).toEqual({ method: 'POST' })
  })

  it('rewrites the URL on a Request input through the binding', async () => {
    const fetcher = fakeFetcher()
    const env = { PLATFORM_WORKER: fetcher }
    const original = new Request('https://app.example.com/internal/files/abc?q=1', {
      method: 'POST',
      headers: { 'x-app-id': 'demo' },
      body: 'payload',
    })

    await platformWorkerFetch(env, original)

    expect(fetcher.fetch).toHaveBeenCalledTimes(1)
    const sent = fetcher.fetch.mock.calls[0][0] as Request
    expect(sent).toBeInstanceOf(Request)
    expect(sent.url).toBe('https://platform-worker/internal/files/abc?q=1')
    expect(sent.method).toBe('POST')
    expect(sent.headers.get('x-app-id')).toBe('demo')
  })

  it('rewrites the URL on a Request input through the URL fallback', async () => {
    const env = { PLATFORM_WORKER_URL: 'https://platform.example.com' }
    const original = new Request('https://app.example.com/internal/files/abc?q=1', {
      method: 'GET',
    })

    await platformWorkerFetch(env, original)

    expect(globalFetchSpy).toHaveBeenCalledTimes(1)
    const sent = globalFetchSpy.mock.calls[0][0] as Request
    expect(sent.url).toBe('https://platform.example.com/internal/files/abc?q=1')
  })

  it('throws an actionable error when neither binding nor URL is configured', () => {
    expect(() => platformWorkerFetch({}, '/internal/files/list')).toThrow(
      /PLATFORM_WORKER.*PLATFORM_WORKER_URL.*\.dev\.vars/s,
    )
  })
})

describe('authWorkerFetch', () => {
  let originalFetch: typeof globalThis.fetch
  let globalFetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    globalFetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('url-ok', { status: 200 }),
    )
    globalThis.fetch = globalFetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('fetches AUTH_WORKER_URL + path', async () => {
    const env = { AUTH_WORKER_URL: 'https://auth.example.com' }
    await authWorkerFetch(env, '/api/auth/jwks')
    expect(globalFetchSpy.mock.calls[0][0]).toBe('https://auth.example.com/api/auth/jwks')
  })

  it('forwards init', async () => {
    const env = { AUTH_WORKER_URL: 'https://auth.example.com' }
    const init: RequestInit = { method: 'POST', body: '{}' }
    await authWorkerFetch(env, '/api/auth/exchange-code', init)
    expect(globalFetchSpy.mock.calls[0][1]).toEqual(init)
  })

  it('strips trailing slash from AUTH_WORKER_URL', async () => {
    const env = { AUTH_WORKER_URL: 'https://auth.example.com/' }
    await authWorkerFetch(env, '/api/auth/jwks')
    expect(globalFetchSpy.mock.calls[0][0]).toBe('https://auth.example.com/api/auth/jwks')
  })

  it('throws when AUTH_WORKER_URL is missing', () => {
    expect(() => authWorkerFetch({}, '/api/auth/jwks')).toThrow(/AUTH_WORKER_URL/)
  })
})
