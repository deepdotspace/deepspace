import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAppIdentityToken, fetchPublicKey, mintAppOwnerJwt } from '../app-tokens'

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

  it('includes the response detail on failure', async () => {
    fetchMock.mockResolvedValue(new Response('not allowed', { status: 403 }))

    await expect(
      mintAppOwnerJwt('https://auth.example.test', 'caller-token', 'app_123'),
    ).rejects.toThrow('Failed to mint APP_OWNER_JWT (403): not allowed')
  })

  it('rejects a successful response without a token', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'mint failed' }))

    await expect(
      mintAppOwnerJwt('https://auth.example.test', 'caller-token', 'app_123'),
    ).rejects.toThrow('Auth worker returned no token: mint failed')
  })
})

describe('fetchAppIdentityToken', () => {
  it('returns null before the app has a deployment', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))

    await expect(
      fetchAppIdentityToken('https://deploy.example.test', 'caller-token', 'app_123'),
    ).resolves.toBeNull()
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

  it('includes the response detail on failure', async () => {
    fetchMock.mockResolvedValue(new Response('unavailable', { status: 503 }))

    await expect(
      fetchAppIdentityToken('https://deploy.example.test', 'caller-token', 'app_123'),
    ).rejects.toThrow('Failed to fetch APP_IDENTITY_TOKEN (503): unavailable')
  })

  it('rejects a successful response without a token', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'token missing' }))

    await expect(
      fetchAppIdentityToken('https://deploy.example.test', 'caller-token', 'app_123'),
    ).rejects.toThrow('Deploy worker returned no token: token missing')
  })
})
