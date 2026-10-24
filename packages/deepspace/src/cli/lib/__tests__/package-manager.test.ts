import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectPackageManager, installCommand, recoveryInstallArgv } from '../package-manager'

describe('package manager detection', () => {
  const dirs: string[] = []
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-pm-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('prefers package.json packageManager over lockfile inference', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.15.0' }))
    writeFileSync(join(dir, 'yarn.lock'), '')
    expect(detectPackageManager(dir)).toBe('pnpm')
    expect(installCommand(dir)).toBe('pnpm install')
  })

  it('keeps a pnpm app on pnpm despite a stray npm lockfile', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    expect(detectPackageManager(dir)).toBe('pnpm')
    expect(installCommand(dir)).toBe('pnpm install')
  })

  it('recognizes bun lockfiles and otherwise defaults to npm', () => {
    const bun = fresh()
    writeFileSync(join(bun, 'bun.lock'), '')
    expect(detectPackageManager(bun)).toBe('bun')
    expect(detectPackageManager(fresh())).toBe('npm')
  })

  it('does not prescribe an install for a raw Worker project', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'wrangler.toml'), 'main = "worker.js"\nno_bundle = true')
    expect(recoveryInstallArgv(dir)).toBeUndefined()
  })
})

it('uses npm ci when a recovered npm lockfile coexists with a stale bun lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-recover-pm-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{}')
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    writeFileSync(join(dir, 'bun.lock'), '')
    expect(recoveryInstallArgv(dir)).toEqual(['npm', 'ci'])
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'bun@1.3.0' }))
    expect(recoveryInstallArgv(dir)).toEqual(['bun', 'install', '--frozen-lockfile'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
