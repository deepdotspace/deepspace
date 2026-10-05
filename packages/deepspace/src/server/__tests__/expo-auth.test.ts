import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nativeAuthCallback,
  nativeAuthExchange,
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

  it('requires JWT configuration for the identity endpoint', async () => {
    const response = await nativeAuthMe(
      new Request('https://example.app.space/api/auth/native-me'),
      { AUTH_WORKER_URL: 'https://auth.deep.space' },
    )
    expect(response.status).toBe(500)
  })
})
