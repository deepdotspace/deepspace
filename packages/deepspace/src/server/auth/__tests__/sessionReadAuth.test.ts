/**
 * resolveSessionReadAuth: which requests may be identified by the session
 * cookie, and how often that costs an auth-worker round trip.
 *
 * The auth-worker is mocked at `authWorkerFetch`; JWT verification is real
 * (jose, ES256) so a bad or expired token is refused by the same code that
 * refuses it in production. Every case uses its own session value because the
 * memo is module-scoped by design — that is the behaviour under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importPKCS8, SignJWT } from 'jose'
import { resolveSessionReadAuth } from '../sessionReadAuth'
import { authWorkerFetch } from '../../utils/proxies'
import { SESSION_COOKIE } from '../../../shared/auth-session'

vi.mock('../../utils/proxies', () => ({ authWorkerFetch: vi.fn() }))
const fetchMock = vi.mocked(authWorkerFetch)

const ISSUER = 'https://auth.test.deep.space'
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHdCNTlzfguOe6KiVagYksU5ZTrQ2
9qMZbXQJesZQOsFR7tdd4qSBuVzv+ZhxOdYmDwGbcCyA+9gdTpdqqFxEOw==
-----END PUBLIC KEY-----`
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgViVa+AqStZtvZ49N
7VVjclAPZuJ3TmQQDeRAiamBxPKhRANCAAQd0I1OXN+C457oqJVqBiSxTllOtDb2
oxltdAl6xlA6wVHu113ipIG5XO/5mHE51iYPAZtwLID72B1Ol2qoXEQ7
-----END PRIVATE KEY-----`
const env = { AUTH_WORKER_URL: ISSUER, AUTH_JWT_PUBLIC_KEY: PUBLIC_KEY, AUTH_JWT_ISSUER: ISSUER }

async function signJwt(subject: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(subject)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 15 * 60)
    .sign(await importPKCS8(PRIVATE_KEY, 'ES256'))
}

/** The auth-worker answers this session's exchange with `subject`'s JWT. */
function exchangeIssues(subject: string): void {
  fetchMock.mockImplementation(async () => Response.json({ token: await signJwt(subject) }))
}

let serial = 0
function request(
  overrides: { method?: string; headers?: Record<string, string>; session?: string } = {},
): { req: Request; session: string } {
  const session = overrides.session ?? `sess-${++serial}-${Math.random().toString(36).slice(2)}`
  const headers = new Headers({
    Cookie: `other=1; ${SESSION_COOKIE}=${session}; theme=dark`,
    'Sec-Fetch-Site': 'same-origin',
    ...overrides.headers,
  })
  for (const [name, value] of Object.entries(overrides.headers ?? {})) {
    if (value === '') headers.delete(name)
  }
  const req = new Request('https://app.example/api/files/apps/a/users/u/x.png?scope=self', {
    method: overrides.method ?? 'GET',
    headers,
  })
  return { req, session }
}

beforeEach(() => {
  fetchMock.mockReset()
  exchangeIssues('user-1')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('which requests qualify', () => {
  it('identifies a same-origin GET, HEAD, and a browser-initiated (none) load', async () => {
    for (const [method, site] of [
      ['GET', 'same-origin'],
      ['HEAD', 'same-origin'],
      ['GET', 'none'],
    ]) {
      const { req } = request({ method, headers: { 'Sec-Fetch-Site': site } })
      expect(await resolveSessionReadAuth(req, env), `${method} ${site}`).toMatchObject({
        userId: 'user-1',
      })
    }
  })

  it('forwards only the session cookie, its value untouched, under a timeout', async () => {
    // Better Auth values are URI-encoded and carry `=` inside; the app's other
    // cookies never leave the app.
    const session = 'abc%2Fdef=.ghi%3D'
    const { req } = request({ session })
    expect(req.headers.get('Cookie')).toContain('other=1')
    await resolveSessionReadAuth(req, env)
    expect(fetchMock).toHaveBeenCalledWith(env, '/api/auth/token', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      signal: expect.any(AbortSignal),
    })
  })

  it.each([
    ['no session cookie', { headers: { Cookie: 'theme=dark' } }],
    ['no Cookie header at all', { headers: { Cookie: '' } }],
    ['a POST', { method: 'POST' }],
    ['a DELETE', { method: 'DELETE' }],
    ['a bearer already present', { headers: { Authorization: 'Bearer whatever' } }],
    [
      'Sec-Fetch-Site: same-site (a sibling *.app.space app)',
      { headers: { 'Sec-Fetch-Site': 'same-site' } },
    ],
    ['Sec-Fetch-Site: cross-site', { headers: { 'Sec-Fetch-Site': 'cross-site' } }],
    ['no Sec-Fetch-Site (pre-16.4 Safari)', { headers: { 'Sec-Fetch-Site': '' } }],
  ])('returns null for %s without calling the auth-worker', async (_label, overrides) => {
    const { req } = request(overrides)
    expect(await resolveSessionReadAuth(req, env)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('one exchange per session', () => {
  it('serves the second request for the same cookie from the memo', async () => {
    const { req, session } = request()
    expect(await resolveSessionReadAuth(req, env)).toMatchObject({ userId: 'user-1' })
    const again = request({ session, method: 'HEAD' })
    expect(await resolveSessionReadAuth(again.req, env)).toMatchObject({ userId: 'user-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('joins concurrent loads to a single in-flight exchange', async () => {
    const { session } = request()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolveSessionReadAuth(request({ session }).req, env)),
    )
    expect(results.every((result) => result?.userId === 'user-1')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-exchanges once the five-minute memo has expired', async () => {
    vi.useFakeTimers()
    const { session } = request()
    expect(await resolveSessionReadAuth(request({ session }).req, env)).toMatchObject({
      userId: 'user-1',
    })
    vi.advanceTimersByTime(5 * 60_000 - 1)
    await resolveSessionReadAuth(request({ session }).req, env)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2)
    exchangeIssues('user-2')
    expect(await resolveSessionReadAuth(request({ session }).req, env)).toMatchObject({
      userId: 'user-2',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('failure', () => {
  it('answers null on a refused exchange and does not remember it', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { session } = request()
    expect(await resolveSessionReadAuth(request({ session }).req, env)).toBeNull()
    expect(await resolveSessionReadAuth(request({ session }).req, env)).toMatchObject({
      userId: 'user-1',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('swallows a thrown transport error and an unverifiable token as null', async () => {
    fetchMock.mockRejectedValueOnce(new Error('AUTH_WORKER_URL is not set'))
    expect(await resolveSessionReadAuth(request().req, env)).toBeNull()

    fetchMock.mockResolvedValueOnce(Response.json({ token: 'not.a.jwt' }))
    expect(await resolveSessionReadAuth(request().req, env)).toBeNull()
  })
})
