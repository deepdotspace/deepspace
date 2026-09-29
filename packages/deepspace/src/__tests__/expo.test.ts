import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  const state = {
    store,
    browserUrl: '',
    randomValues: ['oauth-state', 'verifier-a', 'verifier-b'],
  }
  return state
})

vi.mock('expo-linking', () => ({
  createURL: (path: string) => `veriluma://${path}`,
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
      baseUrl: 'https://veriluma.app.space',
      fetch: fetcher,
    })
    await expect(client.signInWithGoogle()).resolves.toEqual({
      userId: 'user-1',
      claims: { email: 'user@example.com' },
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://veriluma.app.space/api/auth/native-exchange',
      expect.objectContaining({ method: 'POST' }),
    )
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
