import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatSignInFailure,
  getStatePathForEmail,
  tokenClaimsMatchAccount,
} from '../storage-state'

describe('formatSignInFailure', () => {
  it('identifies a throttle instead of blaming stored credentials', () => {
    const message = formatSignInFailure('ada@example.com', {
      status: 429,
      code: null,
      message: 'Too many requests',
    })

    expect(message).toContain('rate-limited')
    expect(message).toContain('60 seconds')
    expect(message).not.toContain('credential')
  })

  it('preserves the status and INVALID_ORIGIN code without exposing credentials', () => {
    const message = formatSignInFailure('ada@example.com', {
      status: 403,
      code: 'INVALID_ORIGIN',
      message: 'Origin is not allowed',
    })

    expect(message).toContain('HTTP 403 INVALID_ORIGIN')
    expect(message).toContain('Add this app origin to the auth allowlist')
  })
})

describe('tokenClaimsMatchAccount', () => {
  const account = { email: 'ada@deepspace.test', userId: 'user_1' }

  it('matches on sub when the registry knows the user id', () => {
    expect(tokenClaimsMatchAccount({ sub: 'user_1' }, account)).toBe(true)
  })

  it('rejects another user even when the token is well-formed', () => {
    expect(tokenClaimsMatchAccount({ sub: 'user_2' }, account)).toBe(false)
  })

  it('falls back to the email claim (case-insensitive) when no user id is stored', () => {
    expect(
      tokenClaimsMatchAccount({ sub: 'user_9', email: 'Ada@deepspace.test' }, { email: 'ada@deepspace.test' }),
    ).toBe(true)
  })

  it('accepts a matching email claim even when sub is unrecognized', () => {
    expect(
      tokenClaimsMatchAccount({ sub: 'user_new', email: 'ada@deepspace.test' }, account),
    ).toBe(true)
  })

  it('rejects when neither claim identifies the account', () => {
    expect(tokenClaimsMatchAccount({}, account)).toBe(false)
    expect(tokenClaimsMatchAccount({ email: 'grace@deepspace.test' }, account)).toBe(false)
    expect(tokenClaimsMatchAccount({ sub: 42, email: 42 }, account)).toBe(false)
    expect(tokenClaimsMatchAccount({ sub: 'user_1' }, { email: 'ada@deepspace.test' })).toBe(false)
  })
})

describe('getStatePathForEmail', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('normalizes the email and reduces baseURL to its origin', () => {
    const path = getStatePathForEmail('ada@deepspace.test', 'http://localhost:5173')
    expect(getStatePathForEmail(' Ada@Deepspace.Test ', 'http://localhost:5173/chat?x=1')).toBe(path)
  })

  it('keys the cache by app origin', () => {
    expect(getStatePathForEmail('ada@deepspace.test', 'http://localhost:5173')).not.toBe(
      getStatePathForEmail('ada@deepspace.test', 'http://localhost:9999'),
    )
  })

  it('keys the cache by auth scope', () => {
    const production = getStatePathForEmail('ada@deepspace.test', 'http://localhost:5173')
    vi.stubEnv('DEEPSPACE_AUTH_URL', 'https://auth.example.com')
    expect(getStatePathForEmail('ada@deepspace.test', 'http://localhost:5173')).not.toBe(production)
  })
})
