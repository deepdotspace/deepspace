import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_MIGRATIONS_MANIFEST,
  applyAppMigrationPlan,
  planAppMigrations,
  readAppliedAppMigrations,
} from '../app-migrations'

let repo: string | undefined
let outside: string | undefined

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true })
  if (outside) rmSync(outside, { recursive: true, force: true })
  repo = undefined
  outside = undefined
})

function makeRepo(worker: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-app-migrations-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  writeFileSync(join(dir, 'worker.ts'), worker)
  execFileSync('git', ['add', 'worker.ts'], { cwd: dir })
  repo = dir
  return dir
}

describe('versioned app source migrations', () => {
  it('rewrites old identity wire forms while retaining physical APP_NAME scopes', () => {
    const dir = makeRepo(`interface Env {
  APP_NAME: string
  APP_IDENTITY_TOKEN?: string
}
const room = env.RECORD_ROOMS.idFromName(\`app:\${env.APP_NAME}\`)
// APP_IDENTITY_TOKEN + APP_NAME authenticates the proxy.
headers.set('x-app-name', env.APP_NAME)
const direct = { 'x-app-name': env.APP_NAME }
headers['x-app-name'] = env.APP_NAME
forwardedParams.set('appName', env.APP_NAME)
forwardedParams.set(  "appName", env.APP_NAME)
// Inject appName into the query string and reject caller-supplied appName.
if (route.injectAppName) use(route)
`)

    const plan = planAppMigrations(dir)
    expect(plan.blockers).toEqual([])
    expect(plan.pending).toEqual([
      expect.objectContaining({
        id: '2026-08-canonical-app-identity-wire',
        files: ['worker.ts'],
        replacements: 5,
      }),
    ])
    expect(plan.changedFiles).toEqual([APP_MIGRATIONS_MANIFEST, 'worker.ts'])

    applyAppMigrationPlan(dir, plan)
    const migrated = readFileSync(join(dir, 'worker.ts'), 'utf-8')
    expect(migrated).toContain('DEEPSPACE_APP_ID: string')
    expect(migrated).toContain("headers.set('x-app-id', env.DEEPSPACE_APP_ID)")
    expect(migrated).toContain("'x-app-id': env.DEEPSPACE_APP_ID")
    expect(migrated).toContain("headers['x-app-id'] = env.DEEPSPACE_APP_ID")
    expect(migrated).toContain("forwardedParams.set('appId', env.DEEPSPACE_APP_ID)")
    expect(migrated).toContain('forwardedParams.set(  "appId", env.DEEPSPACE_APP_ID)')
    expect(migrated).toContain('route.injectAppId')
    expect(migrated).toContain('APP_IDENTITY_TOKEN + DEEPSPACE_APP_ID authenticates the proxy')
    expect(migrated).toContain(
      'Inject appId into the query string and reject caller-supplied appId',
    )
    expect(migrated).toContain('idFromName(`app:${env.APP_NAME}`)')
    expect(readAppliedAppMigrations(dir)).toEqual(['2026-08-canonical-app-identity-wire'])
    expect(planAppMigrations(dir).pending).toEqual([])
  })

  it('records current identity code without rewriting it', () => {
    const dir = makeRepo(`interface Env {
  readonly DEEPSPACE_APP_ID?: string
  APP_NAME: string
}
headers.delete(  'x-app-name')
headers.set('x-app-id', env.DEEPSPACE_APP_ID)
`)
    const plan = planAppMigrations(dir)
    expect(plan.pending).toEqual([
      expect.objectContaining({
        id: '2026-08-canonical-app-identity-wire',
        files: [],
        replacements: 0,
      }),
    ])
    expect(plan.blockers).toEqual([])
    applyAppMigrationPlan(dir, plan)
    expect(readAppliedAppMigrations(dir)).toEqual(['2026-08-canonical-app-identity-wire'])
  })

  it('blocks an unknown legacy wire form instead of guessing', () => {
    const dir = makeRepo(`headers.set(oldHeader ?? 'x-app-name', env.APP_NAME)
headers.set(
  "x-app-name",
  env.APP_NAME,
)
`)
    const plan = planAppMigrations(dir)
    expect(plan.pending).toEqual([
      expect.objectContaining({ id: '2026-08-canonical-app-identity-wire' }),
    ])
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        migrationId: '2026-08-canonical-app-identity-wire',
        file: 'worker.ts',
        line: 1,
      }),
      expect.objectContaining({
        migrationId: '2026-08-canonical-app-identity-wire',
        file: 'worker.ts',
        line: 3,
      }),
    ])
  })

  it('preserves migration ids written by a newer CLI', () => {
    const dir = makeRepo(`headers.set('x-app-name', env.APP_NAME)\n`)
    writeFileSync(join(dir, APP_MIGRATIONS_MANIFEST), '["2027-01-future"]\n')

    const plan = planAppMigrations(dir)
    applyAppMigrationPlan(dir, plan)

    expect(readAppliedAppMigrations(dir)).toEqual([
      '2027-01-future',
      '2026-08-canonical-app-identity-wire',
    ])
  })

  it('rejects a malformed migration manifest', () => {
    const dir = makeRepo('export default {}\n')
    writeFileSync(join(dir, APP_MIGRATIONS_MANIFEST), '{not json}\n')
    expect(() => planAppMigrations(dir)).toThrow('must contain valid JSON')
  })

  it('rejects a tracked migration manifest symlink without reading its target', () => {
    const dir = makeRepo('export default {}\n')
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'ds-app-migrations-outside-')))
    const target = join(outside, 'external.json')
    writeFileSync(target, '[]\n')
    symlinkSync(target, join(dir, APP_MIGRATIONS_MANIFEST))
    execFileSync('git', ['add', APP_MIGRATIONS_MANIFEST], { cwd: dir })

    expect(() => planAppMigrations(dir)).toThrow('must be a regular file, not a symlink')
    expect(readFileSync(target, 'utf-8')).toBe('[]\n')
  })

  it('does not follow a manifest symlink introduced after planning', () => {
    const dir = makeRepo(`headers.set('x-app-name', env.APP_NAME)\n`)
    const plan = planAppMigrations(dir)
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'ds-app-migrations-outside-')))
    const target = join(outside, 'external.json')
    writeFileSync(target, '[]\n')
    symlinkSync(target, join(dir, APP_MIGRATIONS_MANIFEST))

    expect(() => applyAppMigrationPlan(dir, plan)).toThrow('must be a regular file, not a symlink')
    expect(readFileSync(target, 'utf-8')).toBe('[]\n')
    expect(readFileSync(join(dir, 'worker.ts'), 'utf-8')).toContain("'x-app-name'")
  })
})
