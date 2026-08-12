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
})
