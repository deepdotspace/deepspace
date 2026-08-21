import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_MIGRATION_DEFINITIONS,
  APP_MIGRATIONS_MANIFEST,
  pendingAppMigrationGuidance,
  readAppliedAppMigrations,
} from '../app-migrations'

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function appDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepspace-guidance-'))
  made.push(dir)
  mkdirSync(join(dir, 'src'), { recursive: true })
  return dir
}

describe('app migration guidance', () => {
  it('reports every unstamped migration without inspecting or rewriting source', () => {
    const dir = appDir()
    const sourcePath = join(dir, 'src', 'constants.ts')
    writeFileSync(sourcePath, 'declare const __DEEPSPACE_APP_ID__: string\n')

    const pending = pendingAppMigrationGuidance(dir)

    expect(pending.map(({ id }) => id)).toEqual(APP_MIGRATION_DEFINITIONS.map(({ id }) => id))
    expect(readFileSync(sourcePath, 'utf8')).toBe('declare const __DEEPSPACE_APP_ID__: string\n')
    expect(readAppliedAppMigrations(dir)).toEqual([])
  })

  it('uses only the app-owned ledger, preserving unknown future ids', () => {
    const dir = appDir()
    const [applied] = APP_MIGRATION_DEFINITIONS
    writeFileSync(
      join(dir, APP_MIGRATIONS_MANIFEST),
      `${JSON.stringify(['2027-01-future', applied.id])}\n`,
    )

    expect(readAppliedAppMigrations(dir)).toEqual(['2027-01-future', applied.id])
    expect(pendingAppMigrationGuidance(dir).map(({ id }) => id)).not.toContain(applied.id)
  })

  it('refuses malformed ledgers without modifying them', () => {
    const dir = appDir()
    const path = join(dir, APP_MIGRATIONS_MANIFEST)
    writeFileSync(path, '{not json}\n')

    expect(() => pendingAppMigrationGuidance(dir)).toThrow('must contain valid JSON')
    expect(readFileSync(path, 'utf8')).toBe('{not json}\n')
  })
})
