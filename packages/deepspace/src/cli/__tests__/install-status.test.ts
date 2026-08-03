/**
 * ensureInstallReady must distinguish three pre-ready states: install still
 * running (retry later), install FAILED (install.err), and install KILLED
 * without writing any sentinel (dead install.pid) — the last one used to
 * read as "still installing" forever.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureInstallReady } from '../lib/install-status'
import { Refusal } from '../lib/command'
import * as nodeChildProcess from 'node:child_process'

let dirs: string[] = []

function scaffoldDir(sentinels: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-install-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.deepspace'), { recursive: true })
  for (const [name, content] of Object.entries(sentinels)) {
    writeFileSync(join(dir, '.deepspace', name), content)
  }
  return dir
}

/** The guard now refuses (a Refusal renders through the runtime's envelope on
 *  both output paths) instead of process.exit-ing past it. Return the refusal
 *  for message/code assertions. */
function runGuard(dir: string): Refusal {
  try {
    ensureInstallReady(dir)
  } catch (err) {
    expect(err).toBeInstanceOf(Refusal)
    return err as Refusal
  }
  throw new Error('expected ensureInstallReady to refuse')
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('ensureInstallReady', () => {
  it('reports a live dependency install as still installing', () => {
    // Our own pid is definitionally alive.
    const dir = scaffoldDir({ 'install.started': 'x\n', 'install.pid': `${process.pid}\n` })
    expect(runGuard(dir).message).toContain('still installing')
  })

  it('reports a killed install (dead pid) as no longer running, not still installing', () => {
    // Spawn-and-reap a child so we hold a pid that is definitely dead.
    const { spawnSync } = nodeChildProcess
    const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid ?? 999999
    const dir = scaffoldDir({ 'install.started': 'x\n', 'install.pid': `${dead}\n` })
    const out = runGuard(dir)
    expect(out.message).toContain('no longer running')
    expect(out.message).not.toContain('still installing')
    expect(out.code).toBe('install_failed')
  })

  it.each([
    ['missing', {}],
    ['malformed', { 'install.pid': 'not-a-pid\n' }],
  ])('fails a started install with %s worker identity', (_label, pidSentinel) => {
    const dir = scaffoldDir({ 'install.started': 'x\n', ...pidSentinel })
    const out = runGuard(dir)
    expect(out.message).toContain('no longer running')
    expect(out.code).toBe('install_failed')
  })

  it('surfaces install.err as a failed install', () => {
    const dir = scaffoldDir({ 'install.started': 'x\n', 'install.err': 'npm install exited 1\n' })
    expect(runGuard(dir).message).toContain('Dependency install failed')
  })
})
