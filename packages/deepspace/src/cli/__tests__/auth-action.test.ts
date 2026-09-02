import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exists: vi.fn<(path: string) => boolean>(),
  read: vi.fn<(path: string) => string>(() => 'session'),
  exchange: vi.fn(async () => null as string | null),
  exchangeAgent: vi.fn(async () => null as string | null),
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
vi.mock('../session', () => ({
  exchangeSession: mocks.exchange,
  exchangeAgentSession: mocks.exchangeAgent,
}))
vi.mock('../lib/api', () => ({ registerAuthRefresh: vi.fn() }))

import { ensureToken, loginAction, mintAgentToken, SESSION_PATH, TOKEN_PATH } from '../auth'

beforeEach(() => {
  mocks.exists.mockReset()
  mocks.read.mockClear()
  mocks.exchange.mockClear()
  mocks.exchangeAgent.mockClear()
  mocks.write.mockClear()
  mocks.chmod.mockClear()
  // Deterministic loginAction() inputs: the vitest worker is headless, and a
  // developer's real DEEPSPACE_EMAIL/PASSWORD must not leak into the pins.
  vi.stubEnv('DEEPSPACE_EMAIL', '')
  vi.stubEnv('DEEPSPACE_PASSWORD', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('mintAgentToken', () => {
  it('uses only the saved session and never writes the ordinary token cache', async () => {
    mocks.exists.mockImplementation((path) => path === SESSION_PATH)
    mocks.exchangeAgent.mockResolvedValueOnce('target-token')

    await expect(mintAgentToken('https://alpha.app.space')).resolves.toBe('target-token')
    expect(mocks.exchangeAgent).toHaveBeenCalledWith(
      'https://auth.deep.space',
      'session',
      'https://alpha.app.space',
    )
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.chmod).not.toHaveBeenCalled()
  })
})

// Headless without stored credentials (this vitest worker): the bare `auth
// login` action would only reach `interactive_required`, so the contract's
// answer is NO action — recovery needs input only the user can supply (AX C5,
// docs/audits/2026-09-01). The prose still names the headless form.
const loginRefusal = {
  code: 'not_authenticated',
  action: undefined,
}

function jwtExpiringIn(milliseconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor((Date.now() + milliseconds) / 1000) }),
  ).toString('base64url')
  return `header.${payload}.signature`
}

describe('loginAction (the one login-recovery action builder)', () => {
  // isTTY is a plain data property (absent entirely in a vitest worker), so
  // it is set and restored by descriptor, not spied.
  let restoreTTY: Array<() => void> = []
  const stubTTY = (stdin: boolean, stdout: boolean): void => {
    restoreTTY = [
      [process.stdin, stdin] as const,
      [process.stdout, stdout] as const,
    ].map(([stream, value]) => {
      const original = Object.getOwnPropertyDescriptor(stream, 'isTTY')
      Object.defineProperty(stream, 'isTTY', { value, configurable: true })
      return () => {
        if (original) Object.defineProperty(stream, 'isTTY', original)
        else delete (stream as { isTTY?: boolean }).isTTY
      }
    })
  }
  afterEach(() => {
    for (const restore of restoreTTY) restore()
    restoreTTY = []
  })

  it('omits the action headless without credentials — the bare login cannot succeed there', () => {
    stubTTY(false, false)
    expect(loginAction()).toBeUndefined()
  })

  it('ships the bare action when $DEEPSPACE_EMAIL/$DEEPSPACE_PASSWORD make it runnable headless', () => {
    stubTTY(false, false)
    vi.stubEnv('DEEPSPACE_EMAIL', 'agent@example.com')
    vi.stubEnv('DEEPSPACE_PASSWORD', 'secret-enough')
    expect(loginAction()).toMatchObject({ argv: ['deepspace', 'auth', 'login'] })
  })

  it('ships the bare action on an interactive terminal (browser login works there)', () => {
    stubTTY(true, true)
    expect(loginAction()).toMatchObject({ argv: ['deepspace', 'auth', 'login'] })
  })
})

describe('ensureToken recovery action', () => {
  it('omits the login action headless when no session exists', async () => {
    mocks.exists.mockReturnValue(false)

    await expect(ensureToken()).rejects.toMatchObject(loginRefusal)
  })

  it('behaves the same when session refresh fails', async () => {
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
