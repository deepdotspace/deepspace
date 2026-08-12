import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureToken: vi.fn(async () => 'token'),
  fetchRemoteTestAccounts: vi.fn(async () => [
    { id: 'ta_1', email: 'bot@deepspace.test', userId: 'u_1', label: null, createdAt: 0 },
  ]),
  deleteRemoteTestAccount: vi.fn(async () => {}),
  createRemoteTestAccount: vi.fn(),
  syncTestAccountStore: vi.fn(),
  loadAllTestAccounts: vi.fn(() => []),
  removeTestAccounts: vi.fn(),
  upsertTestAccount: vi.fn(),
  confirm: vi.fn(async () => true),
  logError: vi.fn(),
}))

vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))
vi.mock('../../lib/test-account-service', () => ({
  fetchRemoteTestAccounts: mocks.fetchRemoteTestAccounts,
  deleteRemoteTestAccount: mocks.deleteRemoteTestAccount,
  createRemoteTestAccount: mocks.createRemoteTestAccount,
  syncTestAccountStore: mocks.syncTestAccountStore,
}))
vi.mock('../../../testing/accounts', () => ({
  loadAllTestAccounts: mocks.loadAllTestAccounts,
  removeTestAccounts: mocks.removeTestAccounts,
  TEST_ACCOUNTS_PATH: '/tmp/test-accounts.json',
  upsertTestAccount: mocks.upsertTestAccount,
}))
// Every consumer does `import * as p` and touches members at call time, so a
// partial surface is enough: the guard under test must refuse BEFORE confirm.
vi.mock('@clack/prompts', () => ({
  confirm: mocks.confirm,
  isCancel: () => false,
  log: { error: mocks.logError, warn: vi.fn(), info: vi.fn(), success: vi.fn() },
}))

import testAccounts from '../test-accounts'

const clear = (testAccounts as unknown as { subCommands: Record<string, unknown> }).subCommands
  .clear as { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }

const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')

beforeEach(() => {
  // Simulate `printf 'y' | deepspace test accounts clear`: stdin is a pipe.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
})

afterEach(() => {
  if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
  vi.restoreAllMocks()
  // Clear the exit code the runtime records, so a refusal-path test cannot
  // poison the vitest worker's own exit code.
  process.exitCode = undefined
  mocks.fetchRemoteTestAccounts.mockClear()
  mocks.deleteRemoteTestAccount.mockClear()
  mocks.confirm.mockClear()
  mocks.logError.mockClear()
})

describe('test accounts clear confirmation gate', () => {
  it('refuses without --yes when stdin is not a TTY, before deleting anything', async () => {
    // Without the TTY gate, clack's confirm resolves off the pipe, the
    // accounts get deleted, and the paused pipe stays a ref'd handle that
    // hangs the naturally-exiting process (lib/command.ts finishCommand).
    // The guard must refuse up front — same convention as transfer.ts.
    await clear.run({ args: { json: false, yes: false } })

    expect(process.exitCode).toBe(1)
    expect(String(mocks.logError.mock.calls[0]?.[0])).toContain('confirmation_required')
    expect(String(mocks.logError.mock.calls[0]?.[0])).toContain('--yes')
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.deleteRemoteTestAccount).not.toHaveBeenCalled()
  })

  it('still refuses under --json even on a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))

    await clear.run({ args: { json: true, yes: false } })

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(lines[0])).toMatchObject({ ok: false, code: 'confirmation_required' })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.deleteRemoteTestAccount).not.toHaveBeenCalled()
  })
})
