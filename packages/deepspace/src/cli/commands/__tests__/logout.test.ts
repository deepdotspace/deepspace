import { afterEach, describe, expect, it, vi } from 'vitest'
import { revokeSession } from '../logout'

afterEach(() => vi.restoreAllMocks())

describe('revokeSession', () => {
  it('sends the JSON body and Origin Better Auth requires to revoke a session', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"success":true}', { status: 200 }))
    await expect(revokeSession('https://auth.test', 'session-token')).resolves.toBe(true)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('https://auth.test/api/auth/sign-out')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{}')
    const headers = new Headers(init?.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('origin')).toBe('https://auth.test')
    expect(headers.get('cookie')).toContain('session-token')
  })

  it('reports a refused revocation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 415 }))
    await expect(revokeSession('https://auth.test', 'session-token')).resolves.toBe(false)
  })

  it('reports a network failure without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    await expect(revokeSession('https://auth.test', 'session-token')).resolves.toBe(false)
  })
})
