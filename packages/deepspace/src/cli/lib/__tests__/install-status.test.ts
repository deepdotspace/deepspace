import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

// cross-spawn is CJS, so its namespace cannot be spied — mock the module,
// but intercept ONLY `<pm> install` (the heal under test); everything else
// (the real `git` calls resolvesDeepspace's worktree-boundary logic makes)
// passes through to the actual implementation.
const spawnMock = vi.hoisted(() => ({ install: vi.fn() }))
vi.mock('cross-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cross-spawn')>()
  const sync = (cmd: string, args?: readonly string[], opts?: unknown) =>
    cmd !== 'git' && args?.[0] === 'install'
      ? (spawnMock.install as (...a: unknown[]) => unknown)(cmd, args, opts)
      : (actual.sync as (...a: unknown[]) => unknown)(cmd, args, opts)
  return { ...actual, default: Object.assign(sync, actual), sync }
})

import { ensureInstallReady, installState, resolvesDeepspace } from '../install-status'

describe('resolvesDeepspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-install-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('does not cross from a nested linked worktree into the primary checkout', () => {
    const app = join(root, 'app')
    mkdirSync(app, { recursive: true })
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: app })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: app })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: app })
    writeFileSync(join(app, '.gitignore'), 'node_modules\n.deepspace\n')
    writeFileSync(join(app, 'package.json'), '{}\n')
    execFileSync('git', ['add', '.gitignore', 'package.json'], { cwd: app })
    execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: app })

    const worktree = join(app, '.deepspace', 'ws', '01abc')
    execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'ws/test', worktree, 'HEAD'], {
      cwd: app,
    })
    mkdirSync(join(app, 'node_modules', 'deepspace'), { recursive: true })
    writeFileSync(join(app, 'node_modules', 'deepspace', 'package.json'), '{}')

    expect(resolvesDeepspace(app)).toBe(true)
    expect(resolvesDeepspace(worktree)).toBe(false)

    const nestedApp = join(worktree, 'apps', 'web')
    mkdirSync(nestedApp, { recursive: true })
    mkdirSync(join(worktree, 'node_modules', 'deepspace'), { recursive: true })
    writeFileSync(join(worktree, 'node_modules', 'deepspace', 'package.json'), '{}')
    expect(resolvesDeepspace(nestedApp)).toBe(true)
  })

  it('returns false when no ancestor has node_modules/deepspace', () => {
    const bare = join(root, 'bare', 'deep', 'dir')
    mkdirSync(bare, { recursive: true })
    expect(resolvesDeepspace(bare)).toBe(false)
  })

  it('does not treat an unrelated .deepspace directory as an active install', () => {
    const app = join(root, 'markers-only')
    mkdirSync(join(app, '.deepspace'), { recursive: true })
    expect(installState(app)).toBe('missing')
  })

  it('reports explicit install failures', () => {
    const app = join(root, 'failed')
    mkdirSync(join(app, '.deepspace'), { recursive: true })
    writeFileSync(join(app, '.deepspace', 'install.err'), 'failed')
    expect(installState(app)).toBe('failed')
  })
})

describe('ensureInstallReady heals a plain-missing install', () => {
  const root = mkdtempSync(join(tmpdir(), 'ds-install-heal-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  afterEach(() => {
    vi.restoreAllMocks()
    spawnMock.install.mockReset()
  })

  it('runs the detected package manager once and writes the sentinel protocol', () => {
    // A fresh clone self-installs on first use, like an id-less checkout
    // self-registers — the deps_missing refusal is gone for this state.
    const app = join(root, 'clone')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.0.0' }))
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const run = spawnMock.install.mockImplementation((() => {
      // The install's observable effect: deepspace resolves afterwards.
      mkdirSync(join(app, 'node_modules', 'deepspace'), { recursive: true })
      writeFileSync(join(app, 'node_modules', 'deepspace', 'package.json'), '{}')
      return { status: 0, stdout: 'ok', stderr: '', output: [], pid: 1, signal: null }
    }) as never)

    ensureInstallReady(app)

    expect(run).toHaveBeenCalledWith('pnpm', ['install'], expect.objectContaining({ cwd: app }))
    expect(existsSync(join(app, '.deepspace', 'install.done'))).toBe(true)
    // Output streams to the log via a file descriptor (tail-able mid-install,
    // no pipe-buffer cap); the mock writes nothing, so only existence is ours.
    expect(existsSync(join(app, '.deepspace', 'install.log'))).toBe(true)
    // Ready now — a second call never re-runs the install.
    ensureInstallReady(app)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a failing install writes install.err and refuses install_failed with the log', () => {
    const app = join(root, 'broken')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'package.json'), '{}')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    spawnMock.install.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'ERR_PNPM_NO_OFFLINE',
      output: [],
      pid: 1,
      signal: null,
    } as never)

    expect(() => ensureInstallReady(app)).toThrow(
      expect.objectContaining({ code: 'install_failed' }),
    )
    expect(readFileSync(join(app, '.deepspace', 'install.err'), 'utf-8')).toContain('exited 1')
    // The failure is NOT sticky: the next command retries (a transient blip
    // must not permanently re-impose the manual step) — with the manager
    // still failing, it fails loudly again rather than wedging on its own
    // leftover pid sentinel.
    expect(installState(app)).toBe('failed')
    expect(() => ensureInstallReady(app)).toThrow(
      expect.objectContaining({ code: 'install_failed' }),
    )
    expect(spawnMock.install).toHaveBeenCalledTimes(2)
  })
})
