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

// Mirrors the native module's key validation, which rejects anything but
// letters, digits, ".", "-" and "_".
function assertSecureStoreKey(key: string) {
  if (!/^[\w.-]+$/.test(key)) throw new Error('Invalid key provided to SecureStore.')
}

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => {
    assertSecureStoreKey(key)
    return mocks.store.get(key) ?? null
  },
  setItemAsync: async (key: string, value: string) => {
    assertSecureStoreKey(key)
    mocks.store.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    assertSecureStoreKey(key)
    mocks.store.delete(key)
  },
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
    const { createDeepSpaceExpoClient, defaultStorageKey } = await import('../expo')
    const clientA = createDeepSpaceExpoClient({ baseUrl: 'https://a.app.space' })
    const clientB = createDeepSpaceExpoClient({ baseUrl: 'https://b.app.space' })
    await clientA.getSession()
    await clientB.getSession()
    expect(mocks.store.size).toBe(0)
    expect(clientA).not.toBe(clientB)

    const keys = ['https://a.app.space', 'https://b.app.space', 'http://localhost:5173', 'https://a_b.app.space', 'https://a_5f_b.app.space'].map(defaultStorageKey)
    for (const key of keys) expect(key).toMatch(/^[\w.-]+$/)
    expect(new Set(keys).size).toBe(keys.length)
    expect(defaultStorageKey('https://a.app.space')).toBe('deepspace.session.https_3a__2f__2f_a.app.space')
  })

  describe('bearer freshness', () => {
    const nowSeconds = () => Math.floor(Date.now() / 1000)

    function jwt(claims: Record<string, unknown>): string {
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url')
      return `${encode({ alg: 'ES256' })}.${encode(claims)}.signature`
    }

    function memoryStorage(initial?: { sessionToken: string; accessToken: string }) {
      const values = new Map<string, string>()
      if (initial) values.set('session', JSON.stringify(initial))
      return {
        values,
        storage: {
          getItem: async (key: string) => values.get(key) ?? null,
          setItem: async (key: string, value: string) => {
            values.set(key, value)
          },
          deleteItem: async (key: string) => {
            values.delete(key)
          },
        },
      }
    }

    async function clientWith(
      session: { sessionToken: string; accessToken: string } | undefined,
      fetcher: typeof fetch,
    ) {
      const { createDeepSpaceExpoClient } = await import('../expo')
      const { storage, values } = memoryStorage(session)
      const client = createDeepSpaceExpoClient({
        baseUrl: 'https://tasks.app.space/',
        storage,
        storageKey: 'session',
        fetch: fetcher,
      })
      return { client, values }
    }

    it('reuses a bearer that is comfortably unexpired', async () => {
      const current = jwt({ sub: 'user-1', exp: nowSeconds() + 300 })
      const fetcher = vi.fn()
      const { client } = await clientWith({ sessionToken: 's', accessToken: current }, fetcher)
      await expect(client.getAuthToken()).resolves.toBe(current)
      expect(fetcher).not.toHaveBeenCalled()
    })

    it('refreshes an expired or nearly expired bearer before handing it out', async () => {
      const fresh = jwt({ sub: 'user-1', exp: nowSeconds() + 300 })
      for (const exp of [nowSeconds() - 60, nowSeconds() + 10]) {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ accessToken: fresh }), { status: 200 }))
        const { client, values } = await clientWith(
          { sessionToken: 'session-token', accessToken: jwt({ sub: 'user-1', exp }) },
          fetcher as unknown as typeof fetch,
        )
        await expect(client.getAuthToken()).resolves.toBe(fresh)
        expect(fetcher).toHaveBeenCalledWith(
          'https://tasks.app.space/api/auth/native-token',
          expect.objectContaining({ method: 'POST', body: JSON.stringify({ sessionToken: 'session-token' }) }),
        )
        expect(JSON.parse(values.get('session') ?? '{}').accessToken).toBe(fresh)
      }
    })

    it('shares one refresh between concurrent callers', async () => {
      const fresh = jwt({ sub: 'user-1', exp: nowSeconds() + 300 })
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const fetcher = vi.fn(async () => {
        await gate
        return new Response(JSON.stringify({ accessToken: fresh }), { status: 200 })
      })
      const { client } = await clientWith(
        { sessionToken: 's', accessToken: jwt({ sub: 'user-1', exp: nowSeconds() - 1 }) },
        fetcher as unknown as typeof fetch,
      )
      const tokens = Promise.all([client.getAuthToken(), client.getAuthToken(), client.refresh()])
      release()
      await expect(tokens).resolves.toEqual([fresh, fresh, fresh])
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('keeps the old bearer through a transient failure only while it is unexpired', async () => {
      const failing = vi.fn(async () => new Response('{}', { status: 503 }))
      const nearlyExpired = jwt({ sub: 'user-1', exp: nowSeconds() + 10 })
      const live = await clientWith({ sessionToken: 's', accessToken: nearlyExpired }, failing as unknown as typeof fetch)
      await expect(live.client.getAuthToken()).resolves.toBe(nearlyExpired)
      expect(live.values.has('session')).toBe(true)

      const expired = await clientWith(
        { sessionToken: 's', accessToken: jwt({ sub: 'user-1', exp: nowSeconds() - 10 }) },
        failing as unknown as typeof fetch,
      )
      await expect(expired.client.getAuthToken()).resolves.toBeNull()
      expect(expired.values.has('session')).toBe(true)
    })

    it('notifies listeners on refresh and clears the session on a definitive 401', async () => {
      const fresh = jwt({ sub: 'user-1', exp: nowSeconds() + 300 })
      const responses = [
        new Response(JSON.stringify({ accessToken: fresh }), { status: 200 }),
        new Response(JSON.stringify({ error: 'revoked' }), { status: 401 }),
      ]
      const fetcher = vi.fn(async () => responses.shift() ?? new Response('{}', { status: 500 }))
      const { client, values } = await clientWith(
        { sessionToken: 's', accessToken: jwt({ sub: 'user-1', exp: nowSeconds() - 1 }) },
        fetcher as unknown as typeof fetch,
      )
      const seen: Array<string | null> = []
      const unsubscribe = client.subscribe((session) => seen.push(session?.accessToken ?? null))
      await client.refresh()
      await client.refresh()
      unsubscribe()
      await client.signOut()
      expect(seen).toEqual([fresh, null])
      expect(values.has('session')).toBe(false)
      expect(client.origin).toBe('https://tasks.app.space')
    })

    it('decodes base64url claims without atob', async () => {
      const { decodeBase64Url, jwtClaims } = await import('../expo-jwt')
      const encoded = Buffer.from(JSON.stringify({ sub: 'u', name: 'Zoë 李' })).toString('base64url')
      expect(JSON.parse(decodeBase64Url(encoded))).toEqual({ sub: 'u', name: 'Zoë 李' })
      expect(jwtClaims(`h.${encoded}.s`)).toEqual({ sub: 'u', name: 'Zoë 李' })
      expect(jwtClaims('not-a-jwt')).toBeNull()
    })
  })
})
