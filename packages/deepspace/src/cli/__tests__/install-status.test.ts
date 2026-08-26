/**
 * ensureInstallReady's pre-ready states under the first-use heal: only a
 * LIVE install owned by ANOTHER process wait-refuses; every terminal state —
 * a previous failure (install.err), an interrupted install (dead, missing,
 * malformed, or self-owned install.pid) — retries the install right here.
 * Sticky wedges were the old behavior's failure mode: a killed install (or a
 * recycled pid) re-imposed the manual `npm install` the heal exists to
 * remove.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeChildProcess from 'node:child_process'

// cross-spawn is CJS (not spyable); intercept only `<pm> install` and pass
// everything else (git) through to the real implementation.
const spawnMock = vi.hoisted(() => ({ install: vi.fn() }))
vi.mock('cross-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cross-spawn')>()
  const sync = (cmd: string, args?: readonly string[], opts?: unknown) =>
    cmd !== 'git' && args?.[0] === 'install'
      ? (spawnMock.install as (...a: unknown[]) => unknown)(cmd, args, opts)
      : (actual.sync as (...a: unknown[]) => unknown)(cmd, args, opts)
  return { ...actual, default: Object.assign(sync, actual), sync }
})

import { ensureInstallReady } from '../lib/install-status'
import { Refusal } from '../lib/command'

let dirs: string[] = []

function scaffoldDir(sentinels: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-install-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.deepspace'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}\n')
  for (const [name, content] of Object.entries(sentinels)) {
    writeFileSync(join(dir, '.deepspace', name), content)
  }
  return dir
}

function runGuard(dir: string): Refusal {
  try {
    ensureInstallReady(dir)
  } catch (err) {
    expect(err).toBeInstanceOf(Refusal)
    return err as Refusal
  }
  throw new Error('expected ensureInstallReady to refuse')
}

const failingInstall = () =>
  spawnMock.install.mockReturnValue({
    status: 1,
    stdout: '',
    stderr: '',
    output: [],
    pid: 1,
    signal: null,
  } as never)

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  vi.restoreAllMocks()
  spawnMock.install.mockReset()
})

describe('ensureInstallReady', () => {
  it("wait-refuses only for ANOTHER process's live install", () => {
    // A genuinely-alive foreign pid: a sleeping child we own.
    const child = nodeChildProcess.spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], {
      stdio: 'ignore',
    })
    try {
      const dir = scaffoldDir({ 'install.started': 'x\n', 'install.pid': `${child.pid}\n` })
      const out = runGuard(dir)
      expect(out.code).toBe('install_in_progress')
      expect(out.message).toContain('still installing')
      expect(spawnMock.install).not.toHaveBeenCalled()
    } finally {
      child.kill()
    }
  })

  it('our OWN recorded pid is an interrupted attempt, not a live installer — retried', () => {
    // The interrupted-heal wedge: this process wrote the pid, died mid-install
    // (or the pid was recycled), and the old code refused forever.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    failingInstall()
    const dir = scaffoldDir({ 'install.started': 'x\n', 'install.pid': `${process.pid}\n` })
    expect(runGuard(dir).code).toBe('install_failed')
    expect(spawnMock.install).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a dead pid', { 'install.started': 'x\n', 'install.pid': '999999999\n' }],
    ['a missing pid', { 'install.started': 'x\n' }],
    ['a malformed pid', { 'install.started': 'x\n', 'install.pid': 'not-a-pid\n' }],
    ['a previous failure', { 'install.err': 'ERR_SOMETHING\n' }],
  ])('retries an install left behind by %s', (_label, sentinels) => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    failingInstall()
    const dir = scaffoldDir(sentinels as Record<string, string>)
    const out = runGuard(dir)
    expect(out.code).toBe('install_failed')
    expect(out.message).toContain('retried on the next command')
    expect(spawnMock.install).toHaveBeenCalledTimes(1)
  })
})
