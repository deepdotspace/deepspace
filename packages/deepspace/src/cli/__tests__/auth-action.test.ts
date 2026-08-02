import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exists: vi.fn<(path: string) => boolean>(),
  read: vi.fn(() => 'session'),
  exchange: vi.fn(async () => null as string | null),
}))

vi.mock('node:fs', () => ({
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  writeFileSync: vi.fn(),
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
})
