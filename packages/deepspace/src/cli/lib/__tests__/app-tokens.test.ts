import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAppIdentityToken, fetchPublicKey, mintAppOwnerJwt } from '../app-tokens'
import { ApiError } from '../api'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

describe('fetchPublicKey', () => {
  it('returns the auth worker public key', async () => {
    fetchMock.mockResolvedValue(Response.json({ publicKey: 'test-public-key' }))

    await expect(fetchPublicKey('https://auth.example.test')).resolves.toBe('test-public-key')
    expect(fetchMock).toHaveBeenCalledWith('https://auth.example.test/api/auth/jwks')
  })

  it('rejects failed and malformed responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(fetchPublicKey('https://auth.example.test')).rejects.toThrow(
      'Failed to fetch JWT public key (503)',
    )

    fetchMock.mockResolvedValueOnce(Response.json({}))
    await expect(fetchPublicKey('https://auth.example.test')).rejects.toThrow(
      'JWKS response missing publicKey',
    )
  })
})

describe('mintAppOwnerJwt', () => {
  it('posts the caller token and immutable app id', async () => {
    fetchMock.mockResolvedValue(Response.json({ token: 'owner-token' }))

    await expect(
      mintAppOwnerJwt('https://auth.example.test', 'caller-token', 'app_123'),
    ).resolves.toBe('owner-token')
    expect(fetchMock).toHaveBeenCalledWith('https://auth.example.test/api/auth/mint-app-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer caller-token',
      },
      body: JSON.stringify({ appId: 'app_123' }),
    })
  })

  it('includes the response detail on failure, as a status-carrying ApiError', async () => {
    fetchMock.mockResolvedValue(new Response('not allowed', { status: 403 }))

    const failure = mintAppOwnerJwt('https://auth.example.test', 'caller-token', 'app_123')
    await expect(failure).rejects.toThrow('Failed to mint APP_OWNER_JWT (403): not allowed')
    // The status is what deploy's friendly not-authorized branch matches on —
    // a plain Error here silently killed that message.
    await expect(failure).rejects.toMatchObject({ status: 403 })
    await expect(failure).rejects.toBeInstanceOf(ApiError)
  })

  it('rejects a successful response without a token', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'mint failed' }))

    await expect(
      mintAppOwnerJwt('https://auth.example.test', 'caller-token', 'app_123'),
    ).rejects.toThrow('Auth worker returned no token: mint failed')
  })
})

describe('fetchAppIdentityToken', () => {
  it('refuses a 404 loudly — an unresolvable id is wrong, never "not deployed yet"', async () => {
    // Registration happens at `app init`, so a 404 means the id does not
    // exist on THIS platform (wrong environment, hand-edited wrangler.toml).
    // Returning null here made `dev start` write a .dev.vars with no
    // APP_IDENTITY_TOKEN and every platform call fail silently at runtime.
    fetchMock.mockResolvedValue(
      Response.json({ error: 'App not found', code: 'app_not_found' }, { status: 404 }),
    )

    const failure = fetchAppIdentityToken('https://deploy.example.test', 'caller-token', 'app_123')
    await expect(failure).rejects.toThrow('is not registered on this platform')
    await expect(failure).rejects.toMatchObject({ status: 404, code: 'app_not_found' })
    // The remedy is the CALLER's structured, env-aware action — prose from
    // this env-blind lib must not embed a command (a bare `app init` under
    // --env targets the top-level [vars] slot).
    await expect(failure).rejects.not.toThrow(/`/)
  })

  it('a 404 WITHOUT the registry code gets no confident diagnosis', async () => {
    // A wrong DEEPSPACE_DEPLOY_URL answers 404 from Hono's notFound with no
    // `app_not_found` — telling the user their valid app id doesn't exist
    // (and to run `app init`) would be exactly wrong. Point at the URL.
    fetchMock.mockImplementation(async () => Response.json({ error: 'Not found' }, { status: 404 }))

    const failure = fetchAppIdentityToken('https://deploy.example.test', 'caller-token', 'app_123')
    await expect(failure).rejects.toThrow(
      'DEEPSPACE_DEPLOY_URL pointing at the right deploy service',
    )
    await expect(failure).rejects.not.toThrow('is not registered on this platform')
  })

  it('encodes the app id and returns the identity token', async () => {
    fetchMock.mockResolvedValue(Response.json({ token: 'identity-token' }))

    await expect(
      fetchAppIdentityToken('https://deploy.example.test', 'caller-token', 'app /123'),
    ).resolves.toBe('identity-token')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://deploy.example.test/api/apps/app%20%2F123/identity-token',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer caller-token' },
      },
    )
  })

  it('includes the response detail on failure, as a status-carrying ApiError', async () => {
    fetchMock.mockResolvedValue(new Response('unavailable', { status: 503 }))

    const failure = fetchAppIdentityToken('https://deploy.example.test', 'caller-token', 'app_123')
    await expect(failure).rejects.toThrow('Failed to fetch APP_IDENTITY_TOKEN (503): unavailable')
    await expect(failure).rejects.toMatchObject({ status: 503 })
  })

  it('rejects a successful response without a token', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'token missing' }))

    await expect(
      fetchAppIdentityToken('https://deploy.example.test', 'caller-token', 'app_123'),
    ).rejects.toThrow('Deploy worker returned no token: token missing')
  })
})
