/**
 * `wranglerConfigUncommitted` decides whether `app init` may offer
 * `git commit … -- wrangler.toml` as an executable action. The predicate has
 * to match git's own behavior exactly: the action is only honest in the one
 * state where that command succeeds — a tracked, non-conflicted, uncommitted
 * modification.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureToken: vi.fn(async () => 'token'),
  apiFetch: vi.fn(async () => ({ appId: 'app_01JG8QK4M2N7P9RSTVWXYZ0999' })),
  getAppSource: vi.fn(async () => ({ registered: true })),
}))
vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiFetch: mocks.apiFetch,
}))
vi.mock('../../lib/source-api', () => ({ getAppSource: mocks.getAppSource }))

import init, { wranglerConfigUncommitted } from '../init'

let dir: string | undefined

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
}

function makeRepo(): string {
  dir = mkdtempSync(join(tmpdir(), 'ds-init-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.test'])
  git(['config', 'user.name', 'Test'])
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('wranglerConfigUncommitted', () => {
  it('is false outside a git repo', () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-init-'))
    expect(wranglerConfigUncommitted(dir)).toBe(false)
  })

  it('is false for an untracked wrangler.toml — the offered commit would not match the pathspec', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })

  it('is false when the file matches HEAD — the offered commit would fail with nothing to commit', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    git(['add', 'wrangler.toml'])
    git(['commit', '-q', '-m', 'init'])
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })

  it('is true for a tracked unstaged modification, and the offered command succeeds', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    git(['add', 'wrangler.toml'])
    git(['commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n[vars]\nDEEPSPACE_APP_ID = "app_1"\n')

    expect(wranglerConfigUncommitted(repo)).toBe(true)
    git(['commit', '-m', 'register', '--', 'wrangler.toml'])
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })

  it('is true for a staged modification', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    git(['add', 'wrangler.toml'])
    git(['commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "y"\n')
    git(['add', 'wrangler.toml'])
    expect(wranglerConfigUncommitted(repo)).toBe(true)
  })

  it('is false during ANY merge in progress — git refuses every partial commit mid-merge', () => {
    // The conflict is in an unrelated file and wrangler.toml is cleanly
    // modified; porcelain would say ` M`, but the offered command still fails.
    const repo = makeRepo()
    writeFileSync(join(repo, 'other.txt'), 'base\n')
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'base'])
    git(['switch', '-q', '-c', 'other'])
    writeFileSync(join(repo, 'other.txt'), 'other\n')
    git(['commit', '-q', '-am', 'other'])
    git(['switch', '-q', 'main'])
    writeFileSync(join(repo, 'other.txt'), 'main\n')
    git(['commit', '-q', '-am', 'main'])
    try {
      git(['merge', 'other'])
    } catch {
      // Conflict expected.
    }
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "modified"\n')
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })

  it('is false for an unmerged (conflicted) file — git refuses a partial commit mid-merge', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "base"\n')
    git(['add', 'wrangler.toml'])
    git(['commit', '-q', '-m', 'base'])
    git(['switch', '-q', '-c', 'other'])
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "other"\n')
    git(['commit', '-q', '-am', 'other'])
    git(['switch', '-q', 'main'])
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "main"\n')
    git(['commit', '-q', '-am', 'main'])
    try {
      git(['merge', 'other'])
    } catch {
      // Conflict expected — that is the state under test.
    }
    expect(wranglerConfigUncommitted(repo)).toBe(false)
  })
})

describe('app init on a malformed DEEPSPACE_APP_ID', () => {
  const MINTED = 'app_01JG8QK4M2N7P9RSTVWXYZ0999'
  const originalCwd = process.cwd()

  async function runInit(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    const command = init as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { json: true, 'new-id': false, ...args } })
    return JSON.parse(lines[0]) as Record<string, unknown>
  }

  afterEach(() => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
    process.exitCode = undefined
    mocks.apiFetch.mockClear()
  })

  it('refuses without --new-id (invalid_app_id, no id minted, file untouched)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-init-'))
    writeFileSync(join(dir, 'wrangler.toml'), 'name = "x"\n[vars]\nDEEPSPACE_APP_ID = "not-an-app-id"\n')
    process.chdir(dir)
    const out = await runInit({})
    expect(out).toMatchObject({ ok: false, code: 'invalid_app_id' })
    expect(String(out.error)).toContain('"not-an-app-id"')
    expect(out.action).toBeUndefined()
    expect(process.exitCode).toBe(1)
    expect(mocks.apiFetch).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'wrangler.toml'), 'utf-8')).toContain('"not-an-app-id"')
  })

  it('--new-id replaces it, and the result names what it replaced and the plane', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-init-'))
    writeFileSync(join(dir, 'wrangler.toml'), 'name = "x"\n[vars]\nDEEPSPACE_APP_ID = "not-an-app-id"\n')
    process.chdir(dir)
    const out = await runInit({ 'new-id': true })
    expect(out).toMatchObject({
      ok: true,
      status: 'registered',
      appId: MINTED,
      replacedMalformed: 'not-an-app-id',
      env: 'production',
      wranglerEnv: null,
    })
    expect(out.previousAppId).toBeUndefined()
    expect(readFileSync(join(dir, 'wrangler.toml'), 'utf-8')).toContain(`DEEPSPACE_APP_ID = "${MINTED}"`)
  })

  it('reports the plane (env) and the wrangler slot (wranglerEnv) separately when already initialized', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-init-'))
    writeFileSync(join(dir, 'wrangler.toml'), `name = "x"\n[vars]\nDEEPSPACE_APP_ID = "${MINTED}"\n`)
    process.chdir(dir)
    expect(await runInit({})).toMatchObject({
      status: 'already_initialized',
      appId: MINTED,
      env: 'production',
      wranglerEnv: null,
    })
  })
})

describe('app init on an id no server ever registered', () => {
  const LEGACY = 'app_01M09V7WEBZAF17Y3Z9V47CPB5'
  const originalCwd = process.cwd()

  afterEach(() => {
    process.chdir(originalCwd)
    vi.restoreAllMocks()
    process.exitCode = undefined
    mocks.getAppSource.mockReset()
    mocks.getAppSource.mockResolvedValue({ registered: true })
  })

  async function runInit(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    const command = init as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { json: true, 'new-id': false, ...args } })
    return JSON.parse(lines[0]) as Record<string, unknown>
  }

  it('refuses with the fork as an executable action — there is no data decision to make', async () => {
    // The refusal already said "nothing to migrate — the old id never had
    // server-side state"; that is exactly the condition under which
    // `--new-id` is the one next command, so it ships as the action.
    dir = mkdtempSync(join(tmpdir(), 'ds-init-'))
    writeFileSync(join(dir, 'wrangler.toml'), `name = "x"\n[vars]\nDEEPSPACE_APP_ID = "${LEGACY}"\n`)
    process.chdir(dir)
    mocks.getAppSource.mockResolvedValueOnce({ registered: false })
    const out = await runInit({})
    expect(out).toMatchObject({ ok: false, code: 'app_not_registered' })
    expect((out.action as { argv: string[] }).argv).toEqual([
      'deepspace',
      'app',
      'init',
      '--new-id',
    ])
    expect(String(out.error)).toContain('nothing to migrate')
    expect(process.exitCode).toBe(1)
  })

  it('carries --env into the action, since each env is its own registration', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ds-init-'))
    writeFileSync(
      join(dir, 'wrangler.toml'),
      `name = "x"\n[env.staging.vars]\nDEEPSPACE_APP_ID = "${LEGACY}"\n`,
    )
    process.chdir(dir)
    mocks.getAppSource.mockResolvedValueOnce({ registered: false })
    const out = await runInit({ env: 'staging' })
    expect((out.action as { argv: string[] }).argv).toEqual([
      'deepspace',
      'app',
      'init',
      '--new-id',
      '--env',
      'staging',
    ])
  })
})
