/**
 * The `not_authenticated` refusal must say WHICH plane it is about. With
 * `DEEPSPACE_ENV=staging` selected and only a production session stored, the
 * old sentence ("Not logged in") was indistinguishable from a plain logout —
 * and its `auth login` action then logged the caller in on staging.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exists: vi.fn<(path: string) => boolean>(),
  read: vi.fn<(path: string) => string>(),
}))

vi.mock('node:fs', () => ({
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
}))
vi.mock('node:os', () => ({ homedir: () => '/tmp/deepspace-auth-plane-test' }))
vi.mock('../session', () => ({ exchangeSession: vi.fn(async () => null) }))
vi.mock('../lib/api', () => ({ registerAuthRefresh: vi.fn() }))

const PROD_SESSION = '/tmp/deepspace-auth-plane-test/.deepspace/session'

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
  mocks.exists.mockReset()
  mocks.read.mockReset()
  mocks.read.mockImplementation((path) => {
    if (mocks.exists(path)) return 'session'
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT', path })
  })
})

describe('not_authenticated on a non-default plane', () => {
  it('DEEPSPACE_ENV=staging with a production session: says so, and how to select production', async () => {
    vi.stubEnv('DEEPSPACE_ENV', 'staging')
    mocks.exists.mockImplementation((path) => path === PROD_SESSION)
    const { ensureToken } = await import('../auth')
    const err = await ensureToken().catch((e: Error) => e)
    expect(err).toMatchObject({ code: 'not_authenticated' })
    expect((err as Error).message).toMatch(
      /Not logged in on staging \(selected by DEEPSPACE_ENV=staging\)\. You are signed in on production — select that plane \(unset DEEPSPACE_ENV\), or log in here\./,
    )
  })

  it('a DEEPSPACE_AUTH_URL override names the URL and the variable that selected it', async () => {
    vi.stubEnv('DEEPSPACE_AUTH_URL', 'http://192.0.2.1:8794')
    mocks.exists.mockImplementation((path) => path === PROD_SESSION)
    const { ensureToken } = await import('../auth')
    const err = await ensureToken().catch((e: Error) => e)
    expect((err as Error).message).toMatch(
      /Not logged in on the auth service at http:\/\/192\.0\.2\.1:8794 \(selected by DEEPSPACE_AUTH_URL\)\. You are signed in on production — select that plane \(unset DEEPSPACE_AUTH_URL\)/,
    )
  })
})
