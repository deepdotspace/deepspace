/**
 * ensureInstallReady must distinguish three pre-ready states: install still
 * running (retry later), install FAILED (install.err), and install KILLED
 * without writing any sentinel (dead install.pid) — the last one used to
 * read as "still installing" forever.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureInstallReady } from '../lib/install-status'

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

function runGuard(dir: string): string {
  const lines: string[] = []
  vi.spyOn(console, 'error').mockImplementation((msg: string) => lines.push(msg))
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit')
  })
  expect(() => ensureInstallReady(dir)).toThrow('exit')
  return lines.join('\n')
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('ensureInstallReady', () => {
  it('reports a live background install as still installing', () => {
    // Our own pid is definitionally alive.
    const dir = scaffoldDir({ 'install.started': 'x\n', 'install.pid': `${process.pid}\n` })
    expect(runGuard(dir)).toContain('still installing')
  })

  it('reports a killed install (dead pid) as no longer running, not still installing', () => {
    // Spawn-and-reap a child so we hold a pid that is definitely dead.
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const dead = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid ?? 999999
    const dir = scaffoldDir({ 'install.started': 'x\n', 'install.pid': `${dead}\n` })
    const out = runGuard(dir)
    expect(out).toContain('no longer running')
    expect(out).not.toContain('still installing')
  })

  it('without install.pid (older scaffolds) assumes in-progress', () => {
    const dir = scaffoldDir({ 'install.started': 'x\n' })
    expect(runGuard(dir)).toContain('still installing')
  })

  it('surfaces install.err as a failed install', () => {
    const dir = scaffoldDir({ 'install.started': 'x\n', 'install.err': 'npm install exited 1\n' })
    expect(runGuard(dir)).toContain('Background install failed')
  })
})
