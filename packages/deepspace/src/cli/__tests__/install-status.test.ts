/**
 * ensureInstallReady's pre-ready states under the first-use heal: only a
 * LIVE install wait-refuses — install.started with no terminal sentinel
 * (install.done / install.err), younger than the 6-minute age bound. Every
 * terminal state — a previous failure (install.err), an attempt older than
 * the bound — retries the install right here. Sticky wedges were the old
 * pid-liveness behavior's failure mode: a killed install (or a recycled or
 * zombie pid) re-imposed the manual `npm install` the heal exists to remove;
 * a leftover install.pid is ignored entirely.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** Backdate a sentinel past the 6-minute "still installing" age bound. */
function backdate(dir: string, name: string): void {
  const stale = new Date(Date.now() - 10 * 60 * 1000)
  utimesSync(join(dir, '.deepspace', name), stale, stale)
}

describe('ensureInstallReady', () => {
  it('wait-refuses for a fresh install.started with no terminal sentinel', () => {
    const dir = scaffoldDir({ 'install.started': 'x\n' })
    const out = runGuard(dir)
    expect(out.code).toBe('install_in_progress')
    expect(out.message).toContain('still installing')
    expect(spawnMock.install).not.toHaveBeenCalled()
  })

  it('a failed attempt (install.err beside install.started) is terminal — retried NOW', () => {
    // The heal writes err and leaves started behind; age alone would call
    // that "installing" for 6 minutes. The err sentinel says the attempt
    // ended, so the retry happens on this very command.
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    failingInstall()
    const dir = scaffoldDir({ 'install.started': 'x\n', 'install.err': 'ERR_SOMETHING\n' })
    expect(runGuard(dir).code).toBe('install_failed')
    expect(spawnMock.install).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an attempt older than the age bound', { 'install.started': 'x\n' }, 'install.started'],
    [
      'a stale attempt with a leftover install.pid (the deleted protocol is ignored)',
      { 'install.started': 'x\n', 'install.pid': `${process.pid}\n` },
      'install.started',
    ],
    ['a previous failure', { 'install.err': 'ERR_SOMETHING\n' }, null],
  ])('retries an install left behind by %s', (_label, sentinels, staleName) => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    failingInstall()
    const dir = scaffoldDir(sentinels as Record<string, string>)
    if (staleName) backdate(dir, staleName as string)
    const out = runGuard(dir)
    expect(out.code).toBe('install_failed')
    expect(out.message).toContain('retried on the next command')
    expect(spawnMock.install).toHaveBeenCalledTimes(1)
  })
})
