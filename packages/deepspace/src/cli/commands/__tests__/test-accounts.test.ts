import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestAccount } from '../../../testing/accounts'

const mocks = vi.hoisted(() => ({
  ensureToken: vi.fn(async () => 'token'),
  fetchRemoteTestAccounts: vi.fn(async () => [
    { id: 'ta_1', email: 'bot@deepspace.test', userId: 'u_1', label: null, createdAt: 0 },
  ]),
  deleteRemoteTestAccount: vi.fn(async () => {}),
  recoverRemoteTestAccount: vi.fn(),
  createRemoteTestAccount: vi.fn(),
  syncTestAccountStore: vi.fn(),
  // Annotated, not inferred: `() => []` types the mock's return as `never[]`,
  // so any `mockReturnValue` with a real account in it fails to compile.
  loadAllTestAccounts: vi.fn((): TestAccount[] => []),
  removeTestAccounts: vi.fn(),
  upsertTestAccount: vi.fn(),
  confirm: vi.fn(async () => true),
  logError: vi.fn(),
}))

vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))
vi.mock('../../lib/test-account-service', () => ({
  fetchRemoteTestAccounts: mocks.fetchRemoteTestAccounts,
  deleteRemoteTestAccount: mocks.deleteRemoteTestAccount,
  recoverRemoteTestAccount: mocks.recoverRemoteTestAccount,
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

type RunnableCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }
const subCommands = (testAccounts as unknown as { subCommands: Record<string, RunnableCommand> })
  .subCommands
const clear = subCommands.clear
const list = subCommands.list
const create = subCommands.create
const recover = subCommands.recover

function captureLog(): string[] {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
  return lines
}

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
  // mockReset restores the original implementation passed to vi.fn().
  mocks.syncTestAccountStore.mockReset()
  mocks.loadAllTestAccounts.mockReset()
  mocks.createRemoteTestAccount.mockReset()
  mocks.upsertTestAccount.mockClear()
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
    const lines = captureLog()

    await clear.run({ args: { json: true, yes: false } })

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(lines[0])).toMatchObject({ ok: false, code: 'confirmation_required' })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.deleteRemoteTestAccount).not.toHaveBeenCalled()
  })
})

/**
 * `recover` rotates a credential. The platform now joins the Better Auth
 * `user` row into the rotate response, so the display name comes back with it;
 * an older platform sends none, and the local store is the only source left.
 * Writing `email.split('@')[0]` as one invented a name the app never renders —
 * and the shipped collab spec compared the page against exactly that field.
 */
describe('test accounts recover display names', () => {
  const remote = { id: 'ta_1', email: 'collab-a@deepspace.test', userId: 'u_1', label: null, createdAt: 0 }

  beforeEach(() => {
    mocks.upsertTestAccount.mockClear()
    mocks.fetchRemoteTestAccounts.mockResolvedValue([remote])
    mocks.recoverRemoteTestAccount.mockResolvedValue({ ...remote, password: 'rotated' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('restores the display name the rotate response carries', async () => {
    // The whole point of the join: this machine has never seen the account.
    mocks.loadAllTestAccounts.mockReturnValue([])
    mocks.recoverRemoteTestAccount.mockResolvedValue({
      ...remote,
      password: 'rotated',
      name: 'Collab A',
    })

    await recover.run({ args: { email: remote.email, json: true } })

    expect(mocks.upsertTestAccount).toHaveBeenCalledWith(
      expect.objectContaining({ email: remote.email, name: 'Collab A' }),
    )
  })

  it('keeps the display name this machine already knows', async () => {
    mocks.loadAllTestAccounts.mockReturnValue([
      { id: 'ta_1', email: remote.email, password: 'old', name: 'Collab A' },
    ])

    await recover.run({ args: { email: remote.email, json: true } })

    expect(mocks.upsertTestAccount).toHaveBeenCalledWith(
      expect.objectContaining({ email: remote.email, password: 'rotated', name: 'Collab A' }),
    )
  })

  it('stores no display name at all when it does not know one', async () => {
    mocks.loadAllTestAccounts.mockReturnValue([])

    await recover.run({ args: { all: true, json: true } })

    expect(mocks.upsertTestAccount).toHaveBeenCalledTimes(1)
    expect(mocks.upsertTestAccount.mock.calls[0][0]).not.toHaveProperty('name')
  })
})

describe('test accounts list local-record merge', () => {
  beforeEach(() => {
    mocks.syncTestAccountStore.mockResolvedValue({
      accounts: [
        { id: 'ta_1', email: 'alpha@deepspace.test', userId: 'u_1', label: 'e2e', createdAt: 0 },
        { id: 'ta_2', email: 'ghost@deepspace.test', userId: 'u_2', label: null, createdAt: 1 },
      ],
      removed: 0,
    })
    // Only alpha has a local record — ghost is remote-only.
    mocks.loadAllTestAccounts.mockReturnValue([
      { id: 'ta_1', email: 'alpha@deepspace.test', password: 'Secret123!', name: 'Alpha' },
    ])
  })

  it('prints the selector and masks the password unless --reveal', async () => {
    const lines = captureLog()

    await list.run({ args: { json: false, usable: false, reveal: false } })

    const output = lines.join('\n')
    expect(output).toContain('Selector: Alpha')
    expect(output).toContain('Password: (saved locally)')
    expect(output).not.toContain('Secret123!')
    expect(output).toContain('Selector: (none)')
    expect(output).toContain('not usable by the users() fixture')
  })

  it('prints the raw password with --reveal', async () => {
    const lines = captureLog()

    await list.run({ args: { json: false, usable: false, reveal: true } })

    expect(lines.join('\n')).toContain('Password: Secret123!')
  })

  it('emits name and usableByFixture in --json, password left as is', async () => {
    const lines = captureLog()

    await list.run({ args: { json: true, usable: false, reveal: false } })

    const envelope = JSON.parse(lines[0]) as {
      ok: boolean
      accounts: Array<Record<string, unknown>>
    }
    expect(envelope.ok).toBe(true)
    expect(envelope.accounts[0]).toMatchObject({
      email: 'alpha@deepspace.test',
      name: 'Alpha',
      password: 'Secret123!',
      usableByFixture: true,
    })
    expect(envelope.accounts[1]).toMatchObject({
      email: 'ghost@deepspace.test',
      name: null,
      password: null,
      usableByFixture: false,
    })
  })

  it('--usable drops rows without a locally saved password', async () => {
    const lines = captureLog()

    await list.run({ args: { json: true, usable: true, reveal: false } })

    const envelope = JSON.parse(lines[0]) as { accounts: Array<{ email: string }>; count: number }
    expect(envelope.accounts.map((a) => a.email)).toEqual(['alpha@deepspace.test'])
    expect(envelope.count).toBe(1)
  })
})

describe('test accounts create selector default', () => {
  beforeEach(() => {
    mocks.createRemoteTestAccount.mockResolvedValue({
      id: 'ta_9',
      email: 'bot@deepspace.test',
      userId: 'u_9',
      label: null,
      createdAt: 42,
    })
  })

  it('defaults --name to the email local-part so the account stays selectable', async () => {
    const lines = captureLog()

    await create.run({ args: { json: true, email: 'bot@deepspace.test', password: 'Password1!' } })

    expect(mocks.createRemoteTestAccount).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bot' }),
    )
    expect(mocks.upsertTestAccount).toHaveBeenCalledWith(expect.objectContaining({ name: 'bot' }))
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, name: 'bot' })
  })

  it('keeps an explicit --name', async () => {
    captureLog()

    await create.run({
      args: { json: true, email: 'bot@deepspace.test', password: 'Password1!', name: 'Bot Prime' },
    })

    expect(mocks.upsertTestAccount).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Bot Prime' }),
    )
  })
})
