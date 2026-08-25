/**
 * apiFetch error shape: the thrown message is the server's sentence ONLY —
 * the internal REST path (`API /api/… (NNN):`) used to leak onto every
 * collaborators/transfer refusal and read like a stack trace. The path and
 * status live on the error's fields for DEBUG rendering and branching.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  apiFetch,
  apiFetchReadWithRetry,
  apiFetchWithTransientRetry,
  ApiError,
  registerAuthRefresh,
} from '../lib/api'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  registerAuthRefresh(async () => null)
})

describe('apiFetchReadWithRetry', () => {
  it('retries transient network failures for a read', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const request = apiFetchReadWithRetry<{ ok: boolean }>('https://x', 'tok', '/api/thing')
    await vi.runAllTimersAsync()

    await expect(request).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a non-transient refusal', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: 'Forbidden', code: 'forbidden' }, { status: 403 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetchReadWithRetry('https://x', 'tok', '/api/thing')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rebuilds an explicitly idempotent mutation after a lost response', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const request = apiFetchWithTransientRetry<{ ok: boolean }>('https://x', 'tok', '/api/secret', {
      method: 'PUT',
      body: JSON.stringify({ value: 'secret' }),
    })
    await vi.runAllTimersAsync()

    await expect(request).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map((call) => call[1]?.body)).toEqual([
      '{"value":"secret"}',
      '{"value":"secret"}',
    ])
  })

  it('does not multiply an exhausted auth refresh inside an outer read retry', async () => {
    const authError = new ApiError(
      'Auth service unavailable',
      503,
      'auth_service_unavailable',
      '/api/auth/token',
    )
    const refresh = vi.fn(async () => {
      throw authError
    })
    registerAuthRefresh(refresh)
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(apiFetchReadWithRetry('https://x', 'expired', '/api/thing')).rejects.toBe(
      authError,
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
  })
})

function stubResponse(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    ),
  )
}

describe('apiFetch errors', () => {
  it('throws the server sentence only, with path/status/code on fields', async () => {
    stubResponse(429, {
      error: 'Accepting exceeds your deployed-app limit (1/1).',
      code: 'quota_exceeded',
    })
    const err = (await apiFetch('https://x', 'tok', '/api/apps/app_1/transfer/accept').catch(
      (e) => e,
    )) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toBe('Accepting exceeds your deployed-app limit (1/1).')
    expect(err.message).not.toMatch(/API \/api/)
    expect(err.status).toBe(429)
    expect(err.code).toBe('quota_exceeded')
    expect(err.apiPath).toBe('/api/apps/app_1/transfer/accept')
  })

  it('falls back to a generic sentence when the body has no error text', async () => {
    stubResponse(502, '')
    const err = (await apiFetch('https://x', 'tok', '/api/thing').catch((e) => e)) as ApiError
    expect(err.message).toBe('Request failed (502)')
  })

  it('preserves an auth-service outage while recovering a rejected bearer', async () => {
    const authError = new ApiError('Auth service unavailable', 503, 'auth_service_unavailable')
    registerAuthRefresh(async () => {
      throw authError
    })
    stubResponse(401, { error: 'Invalid or expired token' })

    await expect(apiFetch('https://x', 'expired', '/api/thing')).rejects.toBe(authError)
  })
})
