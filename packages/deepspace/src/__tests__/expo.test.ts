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

it('a refresh finishing after sign-out must not restore the old session', async () => {
  const { createDeepSpaceExpoClient } = await import('../expo')
  let saved: string | null = JSON.stringify({
    sessionToken: 'old-session',
    accessToken: 'old-access',
  })
  let release!: (response: Response) => void
  let started!: () => void
  const began = new Promise<void>((r) => (started = r))
  const delayed = new Promise<Response>((r) => (release = r))
  const client = createDeepSpaceExpoClient({
    baseUrl: 'https://example.app.space',
    storageKey: 'audit',
    storage: {
      getItem: async () => saved,
      setItem: async (_k, v) => {
        saved = v
      },
      deleteItem: async () => {
        saved = null
      },
    },
    fetch: async (url) => {
      if (String(url).endsWith('/native-token')) {
        started()
        return delayed
      }
      return Response.json({ ok: true })
    },
  })
  const refresh = client.refresh()
  await began
  await client.signOut()
  expect(await client.getSession()).toBeNull()
  release(Response.json({ accessToken: 'fresh-old-account-access' }))
  await refresh
  expect(await client.getSession()).toBeNull()
  expect(saved).toBeNull()
})

it.each([200, 401])(
  'an old refresh (%s) cannot replace or erase a newly signed-in account',
  async (status) => {
    const { createDeepSpaceExpoClient } = await import('../expo')
    mocks.browserResult = null
    let saved: string | null = JSON.stringify({
      sessionToken: 'old-session',
      accessToken: 'old-access',
    })
    let release!: (response: Response) => void
    let started!: () => void
    const began = new Promise<void>((r) => (started = r))
    const delayed = new Promise<Response>((r) => (release = r))
    const client = createDeepSpaceExpoClient({
      baseUrl: 'https://example.app.space',
      storageKey: 'session',
      storage: {
        getItem: async () => saved,
        setItem: async (_k, v) => {
          saved = v
        },
        deleteItem: async () => {
          saved = null
        },
      },
      fetch: async (url) => {
        if (String(url).endsWith('/native-token')) {
          started()
          return delayed
        }
        if (String(url).endsWith('/native-exchange'))
          return Response.json({ sessionToken: 'new-session', accessToken: 'new-access' })
        return Response.json({ userId: 'new-user', claims: { sub: 'new-user' } })
      },
    })
    const refresh = client.refresh()
    await began
    await client.signIn('google', 'new-state')
    release(
      Response.json(status === 200 ? { accessToken: 'old-refreshed' } : { error: 'expired' }, {
        status,
      }),
    )
    expect(await refresh).toBeNull()
    expect(await client.getSession()).toEqual({
      sessionToken: 'new-session',
      accessToken: 'new-access',
    })
    expect(JSON.parse(saved!)).toEqual({ sessionToken: 'new-session', accessToken: 'new-access' })
  },
)

it('serializes SecureStore saves before a later sign-out delete', async () => {
  const { createDeepSpaceExpoClient } = await import('../expo')
  let saved: string | null = JSON.stringify({
    sessionToken: 'old-session',
    accessToken: 'old-access',
  })
  let release!: () => void
  let started!: () => void
  const began = new Promise<void>((r) => (started = r))
  const delayed = new Promise<void>((r) => (release = r))
  const changes: unknown[] = []
  const client = createDeepSpaceExpoClient({
    baseUrl: 'https://example.app.space',
    storageKey: 'session',
    storage: {
      getItem: async () => saved,
      setItem: async (_k, v) => {
        started()
        await delayed
        saved = v
      },
      deleteItem: async () => {
        saved = null
      },
    },
    fetch: async () => Response.json({ accessToken: 'fresh-access' }),
  })
  client.subscribe((value) => changes.push(value))
  const refresh = client.refresh()
  await began
  const signOut = client.signOut()
  await Promise.resolve()
  release()
  await signOut
  expect(await refresh).toBeNull()
  expect(saved).toBeNull()
  expect(await client.getSession()).toBeNull()
  expect(changes).toEqual([null])
})

describe('session changes during requests', () => {
  beforeEach(() => {
    mocks.browserResult = null
    mocks.store.clear()
  })

  it('does not retry an old account mutation as a newly signed-in account', async () => {
    const { createDeepSpaceExpoClient } = await import('../expo')
    mocks.store.set('session', JSON.stringify({ sessionToken: 'old', accessToken: 'old-access' }))
    let release!: (response: Response) => void
    let started!: () => void
    const began = new Promise<void>((resolve) => (started = resolve))
    const delayed = new Promise<Response>((resolve) => (release = resolve))
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/mutate') {
        started()
        return delayed
      }
      if (path.endsWith('/native-exchange')) {
        return Response.json({ sessionToken: 'new', accessToken: 'new-access' })
      }
      if (path.endsWith('/native-token')) return Response.json({ accessToken: 'new-refreshed' })
      return Response.json({ userId: 'new-user', claims: {} })
    })
    const client = createDeepSpaceExpoClient({
      baseUrl: 'https://example.app.space',
      storageKey: 'session',
      fetch: fetcher,
    })
    const mutation = client.request('/api/mutate', { method: 'POST', body: '{}' })
    await began
    await client.signIn()
    release(Response.json({ error: 'expired' }, { status: 401 }))
    await expect(mutation).rejects.toMatchObject({ status: 401 })
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/mutate'))).toHaveLength(
      1,
    )
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/native-token'))).toBe(false)
  })

  it('a sign-out waiting for storage does not erase a later sign-in', async () => {
    const { createDeepSpaceExpoClient } = await import('../expo')
    let release!: (value: string | null) => void
    const read = new Promise<string | null>((resolve) => (release = resolve))
    let saved: string | null = null
    const client = createDeepSpaceExpoClient({
      baseUrl: 'https://example.app.space',
      storage: {
        getItem: () => read,
        setItem: async (_key, value) => {
          saved = value
        },
        deleteItem: async () => {
          saved = null
        },
      },
      fetch: async (input) =>
        String(input).endsWith('/native-exchange')
          ? Response.json({ sessionToken: 'new', accessToken: 'new-access' })
          : Response.json({ userId: 'new-user', claims: {} }),
    })
    const signOut = client.signOut()
    await client.signIn()
    release(JSON.stringify({ sessionToken: 'old', accessToken: 'old-access' }))
    await signOut
    expect(await client.getSession()).toEqual({ sessionToken: 'new', accessToken: 'new-access' })
    expect(JSON.parse(saved!)).toEqual({ sessionToken: 'new', accessToken: 'new-access' })
  })

  it('a late identity response does not complete a sign-in after sign-out', async () => {
    const { createDeepSpaceExpoClient } = await import('../expo')
    let release!: (response: Response) => void
    let started!: () => void
    const began = new Promise<void>((resolve) => (started = resolve))
    const delayed = new Promise<Response>((resolve) => (release = resolve))
    const client = createDeepSpaceExpoClient({
      baseUrl: 'https://example.app.space',
      fetch: async (input) => {
        if (String(input).endsWith('/native-exchange')) {
          return Response.json({ sessionToken: 'new', accessToken: 'new-access' })
        }
        if (String(input).endsWith('/native-me')) {
          started()
          return delayed
        }
        return Response.json({ ok: true })
      },
    })
    const signIn = client.signIn()
    await began
    await client.signOut()
    release(Response.json({ userId: 'old-user', claims: {} }))
    await expect(signIn).rejects.toMatchObject({ status: 409 })
    expect(await client.getSession()).toBeNull()
  })
})

it('expiry of the previous session does not cancel a sign-in already in progress', async () => {
  const { createDeepSpaceExpoClient } = await import('../expo')
  mocks.browserResult = null
  mocks.store.set('session', JSON.stringify({ sessionToken: 'old', accessToken: 'old-access' }))
  let release!: (response: Response) => void
  let started!: () => void
  const began = new Promise<void>((resolve) => (started = resolve))
  const delayed = new Promise<Response>((resolve) => (release = resolve))
  const client = createDeepSpaceExpoClient({
    baseUrl: 'https://example.app.space',
    storageKey: 'session',
    fetch: async (input) => {
      if (String(input).endsWith('/native-exchange')) {
        started()
        return delayed
      }
      if (String(input).endsWith('/native-token')) {
        return Response.json({ error: 'expired' }, { status: 401 })
      }
      return Response.json({ userId: 'new-user', claims: {} })
    },
  })
  const signIn = client.signIn()
  await began
  expect(await client.refresh()).toBeNull()
  release(Response.json({ sessionToken: 'new', accessToken: 'new-access' }))
  await expect(signIn).resolves.toMatchObject({ userId: 'new-user' })
  expect((await client.getSession())?.sessionToken).toBe('new')
})

it('does not replay a mutation started while an account switch is awaiting exchange', async () => {
  const { createDeepSpaceExpoClient } = await import('../expo')
  mocks.browserResult = null
  mocks.store.set('session', JSON.stringify({ sessionToken: 'old', accessToken: 'old-access' }))
  let releaseExchange!: (response: Response) => void
  let exchangeStarted!: () => void
  const exchangeBegan = new Promise<void>((resolve) => (exchangeStarted = resolve))
  const exchange = new Promise<Response>((resolve) => (releaseExchange = resolve))
  let releaseMutation!: (response: Response) => void
  let mutationStarted!: () => void
  const mutationBegan = new Promise<void>((resolve) => (mutationStarted = resolve))
  const mutationResponse = new Promise<Response>((resolve) => (releaseMutation = resolve))
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/native-exchange')) {
      exchangeStarted()
      return exchange
    }
    if (String(input).endsWith('/api/mutate')) {
      mutationStarted()
      return mutationResponse
    }
    if (String(input).endsWith('/native-token'))
      return Response.json({ accessToken: 'new-refreshed' })
    return Response.json({ userId: 'new-user', claims: {} })
  })
  const client = createDeepSpaceExpoClient({
    baseUrl: 'https://example.app.space',
    storageKey: 'session',
    fetch: fetcher,
  })
  const signIn = client.signIn()
  await exchangeBegan
  const mutation = client.request('/api/mutate', { method: 'POST', body: '{}' })
  await mutationBegan
  releaseExchange(Response.json({ sessionToken: 'new', accessToken: 'new-access' }))
  await signIn
  releaseMutation(Response.json({ error: 'expired' }, { status: 401 }))
  await expect(mutation).rejects.toMatchObject({ status: 401 })
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/api/mutate'))).toHaveLength(1)
})

it('a late identity response cannot complete sign-in after the new session expires', async () => {
  const { createDeepSpaceExpoClient } = await import('../expo')
  mocks.browserResult = null
  let release!: (response: Response) => void
  let started!: () => void
  const began = new Promise<void>((resolve) => (started = resolve))
  const delayed = new Promise<Response>((resolve) => (release = resolve))
  const client = createDeepSpaceExpoClient({
    baseUrl: 'https://example.app.space',
    fetch: async (input) => {
      if (String(input).endsWith('/native-exchange')) {
        return Response.json({ sessionToken: 'new', accessToken: 'new-access' })
      }
      if (String(input).endsWith('/native-me')) {
        started()
        return delayed
      }
      return Response.json({ error: 'revoked' }, { status: 401 })
    },
  })
  const signIn = client.signIn()
  await began
  expect(await client.refresh()).toBeNull()
  expect(await client.getSession()).toBeNull()
  release(Response.json({ userId: 'revoked-user', claims: {} }))
  await expect(signIn).rejects.toMatchObject({ status: 409 })
})
