import { afterEach, describe, expect, it, vi } from 'vitest'
import { exchangeSession } from '../session'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('exchangeSession', () => {
  it('retries a transient auth-service response before returning a token', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ token: 'fresh-token' }))
    vi.stubGlobal('fetch', fetchMock)

    const exchange = exchangeSession('https://auth.test', 'session')
    await vi.runAllTimersAsync()

    await expect(exchange).resolves.toBe('fresh-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns null only when the auth service confirms the session is invalid', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(exchangeSession('https://auth.test', 'session')).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('preserves a persistent auth-service outage as service failure', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 })),
    )

    const exchange = exchangeSession('https://auth.test', 'session')
    const refusal = expect(exchange).rejects.toMatchObject({
      status: 503,
      code: 'auth_service_unavailable',
    })
    await vi.runAllTimersAsync()
    await refusal
  })

  it('reports the final network outcome instead of an earlier transient response', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('busy', { status: 503 }))
        .mockRejectedValue(new TypeError('connection lost')),
    )

    const exchange = exchangeSession('https://auth.test', 'session')
    const refusal = expect(exchange).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    })
    await vi.runAllTimersAsync()
    await refusal
  })
})
