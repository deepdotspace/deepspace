import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  const state = {
    store,
    browserUrl: '',
    browserResult: null as null | { type: string },
    randomValues: ['oauth-state', 'verifier-a', 'verifier-b'],
  }
  return state
})

vi.mock('expo-linking', () => ({
  createURL: (path: string) => `myapp://${path}`,
}))

vi.mock('expo-crypto', () => ({
  randomUUID: () => mocks.randomValues.shift() ?? 'fallback',
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { BASE64: 'BASE64' },
  digestStringAsync: async () => 'Y2hhbGxlbmdl',
}))

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mocks.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mocks.store.set(key, value) },
  deleteItemAsync: async (key: string) => { mocks.store.delete(key) },
}))

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: async (url: string, redirectUri: string) => {
    if (mocks.browserResult) return mocks.browserResult
    const start = new URL(url)
    return {
      type: 'success',
      url: `${redirectUri}?code=one-time-code&state=${encodeURIComponent(start.searchParams.get('state') ?? '')}`,
    }
  },
}))

describe('DeepSpace Expo client', () => {
  beforeEach(() => {
    mocks.store.clear()
    mocks.browserResult = null
    mocks.randomValues.splice(0, mocks.randomValues.length, 'oauth-state', 'verifier-a', 'verifier-b')
  })

  it('uses PKCE exchange and the native identity route', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/native-exchange')) {
        const body = JSON.parse(String(init?.body))
        expect(body.code).toBe('one-time-code')
        expect(body.code_verifier).toBe('verifieraverifierb')
        return new Response(JSON.stringify({ sessionToken: 'session-token', accessToken: 'access-token' }), { status: 200 })
      }
      if (path.endsWith('/native-me')) {
        return new Response(JSON.stringify({ userId: 'user-1', claims: { email: 'user@example.com' } }), { status: 200 })
      }
      throw new Error(`unexpected ${path}`)
    })

    const { createDeepSpaceExpoClient } = await import('../expo')
    const client = createDeepSpaceExpoClient({
      baseUrl: 'https://example.app.space',
      fetch: fetcher,
    })
    await expect(client.signInWithGoogle()).resolves.toEqual({
      userId: 'user-1',
      claims: { email: 'user@example.com' },
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.app.space/api/auth/native-exchange',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('signs in with a provider ID token and keeps the session', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/auth/native-id-token') {
        expect(JSON.parse(String(init?.body))).toEqual({
          provider: 'apple',
          idToken: 'id-token',
          nonce: 'raw-nonce',
          user: { name: { firstName: 'Ada', lastName: 'Lovelace' } },
        })
        return new Response(JSON.stringify({ sessionToken: 'session-token', accessToken: 'access-token' }), { status: 200 })
      }
      if (path === '/api/auth/native-me') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-token')
        return new Response(JSON.stringify({ userId: 'user-1', claims: {} }), { status: 200 })
      }
      throw new Error(`unexpected ${path}`)
    })
    const { createDeepSpaceExpoClient } = await import('../expo')
    const client = createDeepSpaceExpoClient({ baseUrl: 'https://example.app.space', fetch: fetcher })
    await expect(
      client.signInWithIdToken('apple', 'id-token', { nonce: 'raw-nonce', name: { firstName: 'Ada', lastName: 'Lovelace' } }),
    ).resolves.toEqual({ userId: 'user-1', claims: {} })
    await expect(client.getSession()).resolves.toEqual({ sessionToken: 'session-token', accessToken: 'access-token' })
  })

  it('tells a closed sign-in sheet apart from a failed sign-in', async () => {
    const { createDeepSpaceExpoClient, DeepSpaceSignInCancelledError } = await import('../expo')
    const fetcher = vi.fn()
    const client = createDeepSpaceExpoClient({ baseUrl: 'https://notes.app.space', fetch: fetcher })
    for (const type of ['cancel', 'dismiss']) {
      mocks.browserResult = { type }
      const error = await client.signInWithGoogle().catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(DeepSpaceSignInCancelledError)
      expect(error).toMatchObject({ code: 'sign_in_cancelled' })
    }
    mocks.browserResult = { type: 'locked' }
    const locked = await client.signInWithGoogle().catch((error: unknown) => error)
    expect(locked).toBeInstanceOf(Error)
    expect(locked).not.toBeInstanceOf(DeepSpaceSignInCancelledError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('namespaces the default secure-store key per app origin', async () => {
    const { createDeepSpaceExpoClient } = await import('../expo')
    const clientA = createDeepSpaceExpoClient({ baseUrl: 'https://a.app.space' })
    const clientB = createDeepSpaceExpoClient({ baseUrl: 'https://b.app.space' })
    await clientA.getSession()
    await clientB.getSession()
    expect(mocks.store.size).toBe(0)
    expect(clientA).not.toBe(clientB)
  })
})
