import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exists: vi.fn<(path: string) => boolean>(),
  read: vi.fn<(path: string) => string>(() => 'session'),
  exchange: vi.fn(async () => null as string | null),
  write: vi.fn(),
  chmod: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  writeFileSync: mocks.write,
  chmodSync: mocks.chmod,
  mkdirSync: vi.fn(),
}))
vi.mock('node:os', () => ({ homedir: () => '/tmp/deepspace-auth-action-test' }))
vi.mock('../session', () => ({ exchangeSession: mocks.exchange }))
vi.mock('../lib/api', () => ({ registerAuthRefresh: vi.fn() }))

import { ensureToken, SESSION_PATH, TOKEN_PATH } from '../auth'

beforeEach(() => {
  mocks.exists.mockReset()
  mocks.read.mockClear()
  mocks.exchange.mockClear()
  mocks.write.mockClear()
  mocks.chmod.mockClear()
})

const loginRefusal = {
  code: 'not_authenticated',
  action: {
    cwd: process.cwd(),
    argv: ['deepspace', 'auth', 'login'],
  },
}

function jwtExpiringIn(milliseconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor((Date.now() + milliseconds) / 1000) }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

describe('ensureToken recovery action', () => {
  it('carries an exact login action when no session exists', async () => {
    mocks.exists.mockReturnValue(false)

    await expect(ensureToken()).rejects.toMatchObject(loginRefusal)
  })

  it('carries the same action when session refresh fails', async () => {
    mocks.exists.mockImplementation((path) => path === SESSION_PATH && path !== TOKEN_PATH)

    await expect(ensureToken()).rejects.toMatchObject(loginRefusal)
    expect(mocks.exchange).toHaveBeenCalledOnce()
  })

  it('tightens the refreshed token file even when it already exists', async () => {
    mocks.exists.mockImplementation((path) => path === SESSION_PATH || path === TOKEN_PATH)
    mocks.read.mockImplementation((path) => (path === SESSION_PATH ? 'session' : 'expired-token'))
    mocks.exchange.mockResolvedValueOnce('fresh-token')

    await expect(ensureToken()).resolves.toBe('fresh-token')
    expect(mocks.write).toHaveBeenCalledWith(TOKEN_PATH, 'fresh-token', { mode: 0o600 })
    expect(mocks.chmod).toHaveBeenCalledWith(TOKEN_PATH, 0o600)
  })

  it('refreshes a valid cached JWT that cannot cover the requested operation', async () => {
    const cachedToken = jwtExpiringIn(5 * 60 * 1000)
    mocks.exists.mockImplementation((path) => path === SESSION_PATH || path === TOKEN_PATH)
    mocks.read.mockImplementation((path) => (path === SESSION_PATH ? 'session' : cachedToken))
    mocks.exchange.mockResolvedValueOnce('fresh-token')

    await expect(ensureToken({ minimumValidityMs: 10 * 60 * 1000 })).resolves.toBe('fresh-token')
    expect(mocks.exchange).toHaveBeenCalledOnce()
  })

  it('keeps the cached JWT when it covers the requested operation', async () => {
    const cachedToken = jwtExpiringIn(12 * 60 * 1000)
    mocks.exists.mockImplementation((path) => path === SESSION_PATH || path === TOKEN_PATH)
    mocks.read.mockImplementation((path) => (path === SESSION_PATH ? 'session' : cachedToken))

    await expect(ensureToken({ minimumValidityMs: 10 * 60 * 1000 })).resolves.toBe(cachedToken)
    expect(mocks.exchange).not.toHaveBeenCalled()
  })

  it('does not relabel an auth-service outage as an expired session', async () => {
    const serviceError = new Error('auth service unavailable')
    mocks.exists.mockImplementation((path) => path === SESSION_PATH)
    mocks.exchange.mockRejectedValueOnce(serviceError)

    await expect(ensureToken({ minimumValidityMs: 10 * 60 * 1000 })).rejects.toBe(serviceError)
  })
})

describe('ensureToken not_authenticated sentence', () => {
  it('names the headless login form up front (the bare action refuses without a TTY)', async () => {
    mocks.exists.mockReturnValue(false)
    const err = await ensureToken().catch((e: Error) => e)
    expect((err as Error).message).toMatch(/Not logged in on production\./)
    expect((err as Error).message).toContain('--password-stdin')
    expect((err as Error).message).toContain('DEEPSPACE_EMAIL')
  })

  it('names the plane the session belongs to when the selected plane has none', async () => {
    // Selected: production (no override in this process). Stored: a staging
    // session only — exactly what a `DEEPSPACE_ENV=staging` login leaves behind.
    const stagingSession =
      '/tmp/deepspace-auth-action-test/.deepspace/session.auth-deepspacesites-com'
    mocks.exists.mockImplementation((path) => path === stagingSession)
    const err = await ensureToken().catch((e: Error) => e)
    expect((err as Error).message).toMatch(
      /Not logged in on production\. You are signed in on staging/,
    )
    expect((err as Error).message).toContain('DEEPSPACE_ENV=staging')
    expect(err).toMatchObject(loginRefusal)
  })

  it('says the session is invalid — not merely "expired" — when the refresh is refused', async () => {
    mocks.exists.mockImplementation((path) => path === SESSION_PATH)
    const err = await ensureToken().catch((e: Error) => e)
    expect((err as Error).message).toMatch(
      /no longer valid \(expired or unreadable\) on production/,
    )
  })
})
