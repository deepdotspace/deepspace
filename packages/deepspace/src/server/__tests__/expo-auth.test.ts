import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nativeAuthCallback,
  nativeAuthExchange,
  nativeAuthIdToken,
  nativeAuthMe,
  nativeAuthStart,
  nativeAuthToken,
} from '../expo-auth'

const env = {
  AUTH_WORKER_URL: 'https://auth.deep.space',
  AUTH_JWT_PUBLIC_KEY: 'missing',
  AUTH_JWT_ISSUER: 'https://auth.deep.space',
}
const options = { allowedRedirectUris: ['myapp://auth/callback'] }
const challenge = 'a'.repeat(43)
const verifier = 'v'.repeat(64)

afterEach(() => vi.restoreAllMocks())

describe('Expo native auth bridge', () => {
  it('starts OAuth through the auth worker and preserves the PKCE challenge', () => {
    const request = new Request(
      `https://example.app.space/api/auth/native-start?provider=google&redirect_uri=myapp%3A%2F%2Fauth%2Fcallback&state=s-1&code_challenge=${challenge}&code_challenge_method=S256`,
    )
    const response = nativeAuthStart(request, env, options)
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe('https://auth.deep.space')
    expect(location.pathname).toBe('/login/social')
    expect(location.searchParams.get('provider')).toBe('google')
    const returnTo = new URL(location.searchParams.get('returnTo')!)
    expect(returnTo.pathname).toBe('/api/auth/oauth-complete')
    expect(returnTo.searchParams.get('redirect_uri')).toBe('myapp://auth/callback')
    expect(returnTo.searchParams.get('code_challenge')).toBe(challenge)
    expect(returnTo.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('rejects an unregistered redirect URI', () => {
    const request = new Request(
      `https://example.app.space/api/auth/native-start?provider=google&redirect_uri=https%3A%2F%2Fexample.app.space%2Fevil&code_challenge=${challenge}&code_challenge_method=S256`,
    )
    expect(nativeAuthStart(request, env, options).status).toBe(400)
  })

  it('rejects native starts without PKCE', () => {
    const request = new Request(
      'https://example.app.space/api/auth/native-start?provider=google&redirect_uri=myapp%3A%2F%2Fauth%2Fcallback',
    )
    expect(nativeAuthStart(request, env, options).status).toBe(400)
  })

  it('forwards only the code and state to the registered native URI', () => {
    const request = new Request(
      `https://example.app.space/api/auth/oauth-complete?redirect_uri=myapp%3A%2F%2Fauth%2Fcallback&code=one-time&state=s-1&code_challenge=${challenge}&code_challenge_method=S256`,
    )
    const response = nativeAuthCallback(request, env, options)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('myapp://auth/callback?code=one-time&state=s-1')
  })

  it('exchanges a PKCE-bound code and normalizes the auth-worker token shape', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionToken: 'session-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'access-token' }), { status: 200 }))
    const response = await nativeAuthExchange(
      new Request('https://example.app.space/api/auth/native-exchange', {
        method: 'POST',
        body: JSON.stringify({ code: 'one-time-code', code_verifier: verifier }),
      }),
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionToken: 'session-token', accessToken: 'access-token' })
  })

  it('preserves upstream failures as recoverable errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'overloaded' }), { status: 503 }),
    )
    const response = await nativeAuthToken(
      new Request('https://example.app.space/api/auth/native-token', {
        method: 'POST',
        body: JSON.stringify({ sessionToken: 'a-session-token-that-is-long-enough' }),
      }),
      env,
    )
    expect(response.status).toBe(502)
  })

  it('signs in with a native ID token through Better Auth and mints the first JWT', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ redirect: false, token: 'session-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'access-token' }), { status: 200 }))
    const response = await nativeAuthIdToken(
      new Request('https://example.app.space/api/auth/native-id-token', {
        method: 'POST',
        headers: { Cookie: 'stray=1', Origin: 'https://evil.example' },
        body: JSON.stringify({
          provider: 'apple',
          idToken: 'header.payload.signature',
          nonce: 'n'.repeat(32),
          user: { name: { firstName: ' Ada ', lastName: null } },
        }),
      }),
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionToken: 'session-token', accessToken: 'access-token' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://auth.deep.space/api/auth/sign-in/social')
    // Only the token travels: no browser cookies or origin from the app's caller.
    expect(new Headers(init?.headers).get('cookie')).toBeNull()
    expect(new Headers(init?.headers).get('origin')).toBeNull()
    expect(JSON.parse(String(init?.body))).toEqual({
      provider: 'apple',
      idToken: { token: 'header.payload.signature', nonce: 'n'.repeat(32), user: { name: { firstName: 'Ada' } } },
    })
  })

  it('refuses unsupported providers and reports a rejected token as 401', async () => {
    const post = (body: unknown) =>
      new Request('https://example.app.space/api/auth/native-id-token', { method: 'POST', body: JSON.stringify(body) })
    expect((await nativeAuthIdToken(post({ provider: 'github', idToken: 'x'.repeat(20) }), env)).status).toBe(400)
    expect((await nativeAuthIdToken(post({ provider: 'google' }), env)).status).toBe(400)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'INVALID_TOKEN' }), { status: 401 }),
    )
    const rejected = await nativeAuthIdToken(post({ provider: 'google', idToken: 'x'.repeat(20) }), env)
    expect(rejected.status).toBe(401)
  })

  it('tells an unaccepted provider and rate limiting apart from a bad token', async () => {
    const post = () =>
      new Request('https://example.app.space/api/auth/native-id-token', {
        method: 'POST',
        body: JSON.stringify({ provider: 'apple', idToken: 'x'.repeat(20) }),
      })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'PROVIDER_NOT_FOUND' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'TOO_MANY' }), { status: 429 }))
    expect((await nativeAuthIdToken(post(), env)).status).toBe(503)
    expect((await nativeAuthIdToken(post(), env)).status).toBe(429)
  })

  it('requires JWT configuration for the identity endpoint', async () => {
    const response = await nativeAuthMe(
      new Request('https://example.app.space/api/auth/native-me'),
      { AUTH_WORKER_URL: 'https://auth.deep.space' },
    )
    expect(response.status).toBe(500)
  })
})
