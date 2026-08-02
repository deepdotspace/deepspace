import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectPackageManager, installCommand } from '../package-manager'

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

  it('recognizes bun lockfiles and otherwise defaults to npm', () => {
    const bun = fresh()
    writeFileSync(join(bun, 'bun.lock'), '')
    expect(detectPackageManager(bun)).toBe('bun')
    expect(detectPackageManager(fresh())).toBe('npm')
  })
})
