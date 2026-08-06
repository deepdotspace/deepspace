import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import migrate from '../migrate'
import * as authModule from '../../auth'
import * as appContext from '../../lib/app-context'
import * as migrationApi from '../migrate/identity-api'
import * as repoApiModule from '../../lib/repo-api'
import * as sourceControl from '../../lib/source-control'
import * as sourceApi from '../../lib/source-api'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.
vi.setConfig({ testTimeout: 30_000 })

const LEGACY_ID = 'deepdotspace-site'
const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
const REPOSITORY = 'deepdotspace/deepdotspace-site'
const SOURCE_MIGRATION_ID = '2026-08-canonical-app-identity-wire'
let repo: string | undefined

afterEach(() => {
  vi.restoreAllMocks()
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = undefined
})

function makeRepo(appId = LEGACY_ID): { dir: string; oid: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-migrate-command-')))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(
    join(dir, 'wrangler.toml'),
    `name = "deepdotspace-site"\n\n[vars]\nDEEPSPACE_APP_ID = "${appId}"\n`,
  )
  writeFileSync(
    join(dir, 'deepspace.migrations.json'),
    `${JSON.stringify([SOURCE_MIGRATION_ID])}\n`,
  )
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'source'], { cwd: dir })
  const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim()
  return { dir, oid }
}

function migration(status: migrationApi.IdentityMigration['status'] = 'prepared') {
  return {
    legacyAppId: LEGACY_ID,
    appId: APP_ID,
    resourceId: LEGACY_ID,
    ownerUserId: 'user-owner',
    repository: REPOSITORY,
    sourceRevision: 1,
    status,
    preparedAt: '2026-08-03T00:00:00.000Z',
    committedAt: status === 'prepared' ? null : '2026-08-03T00:01:00.000Z',
    verifiedAt: status === 'verified' ? '2026-08-03T00:02:00.000Z' : null,
    rolledBackAt: status === 'rolled_back' ? '2026-08-03T00:02:00.000Z' : null,
    commitOid: status === 'prepared' ? null : 'a'.repeat(40),
    branch: status === 'prepared' ? null : 'main',
    versionId: status === 'verified' ? 'version-1' : null,
  } satisfies migrationApi.IdentityMigration
}

function inventory(ready = true): migrationApi.IdentityMigrationInventory {
  return {
    observedAt: '2026-08-03T00:00:00.000Z',
    ready,
    blockers: ready ? [] : [{ code: 'pending_transfer', message: 'Cancel the stored transfer' }],
    app: {
      legacyAppId: LEGACY_ID,
      destinationAppId: APP_ID,
      resourceId: LEGACY_ID,
      status: 'active',
      source: { provider: 'github', repository: REPOSITORY },
      sourceRevision: 1,
      deployedAt: '2026-08-02T00:00:00.000Z',
      versionId: 'version-1',
      hasSecretsStore: true,
      sourceClaimRequired: false,
    },
    rekey: {
      appRow: 1,
      routes: [
        {
          host: 'deep.space',
          appId: LEGACY_ID,
          kind: 'custom',
          status: 'active',
          claimedAt: '2026-08-01T00:00:00.000Z',
          releasedAt: null,
          releasedBy: null,
        },
      ],
      collaborators: [
        {
          userId: 'collaborator-1',
          addedAt: '2026-08-01T00:00:00.000Z',
          addedBy: 'user-owner',
        },
      ],
      pendingCollaborators: [],
      transfer: ready
        ? null
        : {
            fromUserId: 'user-owner',
            toUserId: 'owner-2',
            createdAt: '2026-08-03T00:00:00.000Z',
            expiresAt: '2026-08-10T00:00:00.000Z',
          },
    },
    retainedPhysicalStores: [
      { kind: 'worker', resourceId: LEGACY_ID, operation: 'retain' },
      { kind: 'repo_and_releases', resourceId: LEGACY_ID, operation: 'retain' },
    ],
  }
}

async function runMigrateJson(args: Record<string, unknown> = {}) {
  const logs: string[] = []
  const exits: number[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0)
    throw new Error(`exit:${code ?? 0}`)
  }) as never)
  const command = migrate as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }
  await command.run({ args: { json: true, 'dry-run': false, ...args } }).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.startsWith('exit:')) throw error
  })
  return { output: JSON.parse(logs[0]) as Record<string, unknown>, exits }
}

function arrangeRepo(dir: string, oid: string): void {
  vi.spyOn(appContext, 'findAppDir').mockReturnValue(dir)
  vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
  vi.spyOn(sourceControl, 'selectGitHubRemote').mockReturnValue({
    name: 'origin',
    repository: REPOSITORY,
    url: `git@github.com:${REPOSITORY}.git`,
  })
  vi.spyOn(sourceControl, 'remoteBranchOid').mockReturnValue(oid)
  vi.spyOn(sourceApi, 'getAppSource').mockResolvedValue({
    appId: APP_ID,
    source: { provider: 'github', repository: REPOSITORY },
    revision: 1,
    registered: true,
  })
  vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
    latestRelease: vi.fn().mockResolvedValue({
      release: {
        commitOid: null,
        createdAt: '2099-08-03T00:02:00.000Z',
        config: { appMigrations: [SOURCE_MIGRATION_ID] },
      },
    }),
  } as never)
}

describe('legacy app identity migration workflow', () => {
  it('dry-runs an exact read-only re-key and physical-retention inventory', async () => {
    const made = makeRepo()
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(null)
    const inspect = vi
      .spyOn(migrationApi, 'inspectIdentityMigration')
      .mockResolvedValue(inventory())
    const prepare = vi.spyOn(migrationApi, 'prepareIdentityMigration')
    const before = readFileSync(join(repo, 'wrangler.toml'), 'utf-8')

    const { output, exits } = await runMigrateJson({ 'dry-run': true })

    expect(inspect).toHaveBeenCalledWith(expect.any(String), 'token', LEGACY_ID, {
      destinationAppId: expect.stringMatching(/^app_/),
      repository: REPOSITORY,
    })
    expect(output).toMatchObject({
      ok: true,
      status: 'ready',
      resourceId: LEGACY_ID,
      inventory: {
        ready: true,
        rekey: { appRow: 1, routes: [{ host: 'deep.space' }] },
        retainedPhysicalStores: expect.arrayContaining([
          expect.objectContaining({ kind: 'worker', operation: 'retain' }),
        ]),
      },
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(readFileSync(join(repo, 'wrangler.toml'), 'utf-8')).toBe(before)
    expect(exits).toEqual([0])
  })

  it('reports a blocked dry-run without preparing or changing files', async () => {
    const made = makeRepo()
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(null)
    vi.spyOn(migrationApi, 'inspectIdentityMigration').mockResolvedValue(inventory(false))
    const prepare = vi.spyOn(migrationApi, 'prepareIdentityMigration')
    const before = readFileSync(join(repo, 'wrangler.toml'), 'utf-8')

    const { output, exits } = await runMigrateJson({ 'dry-run': true })

    expect(output).toMatchObject({
      ok: false,
      code: 'migration_preflight_blocked',
      inventory: { ready: false, blockers: [{ code: 'pending_transfer' }] },
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(readFileSync(join(repo, 'wrangler.toml'), 'utf-8')).toBe(before)
    expect(exits).toEqual([1])
  })

  it('dry-runs pending source migrations without changing the checkout', async () => {
    const made = makeRepo()
    repo = made.dir
    writeFileSync(
      join(repo, 'worker.ts'),
      `interface Env {\n  APP_NAME: string\n}\nheaders.set('x-app-name', env.APP_NAME)\n`,
    )
    writeFileSync(join(repo, 'deepspace.migrations.json'), '[]\n')
    execFileSync('git', ['add', 'worker.ts', 'deepspace.migrations.json'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'legacy worker'], { cwd: repo })
    const oid = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim()
    arrangeRepo(repo, oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(null)
    vi.spyOn(migrationApi, 'inspectIdentityMigration').mockResolvedValue(inventory())
    const before = readFileSync(join(repo, 'worker.ts'), 'utf-8')

    const { output, exits } = await runMigrateJson({ 'dry-run': true })

    expect(output).toMatchObject({
      ok: true,
      status: 'ready',
      sourceMigrations: [
        {
          id: '2026-08-canonical-app-identity-wire',
          files: ['worker.ts'],
          replacements: 1,
        },
      ],
    })
    expect(readFileSync(join(repo, 'worker.ts'), 'utf-8')).toBe(before)
    expect(exits).toEqual([0])
  })

  it('refuses an untracked wrangler.toml before reserving an identity', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ds-migrate-command-')))
    repo = dir
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
    writeFileSync(join(dir, 'README.md'), 'tracked\n')
    execFileSync('git', ['add', 'README.md'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'source'], { cwd: dir })
    writeFileSync(
      join(dir, 'wrangler.toml'),
      `name = "deepdotspace-site"\n\n[vars]\nDEEPSPACE_APP_ID = "${LEGACY_ID}"\n`,
    )
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(dir)
    const prepare = vi.spyOn(migrationApi, 'prepareIdentityMigration')

    const { output, exits } = await runMigrateJson()

    expect(output).toMatchObject({ ok: false, code: 'wrangler_not_tracked' })
    expect(prepare).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })

  it('prepares the journal, writes deterministic migration files, and returns an exact commit action', async () => {
    const made = makeRepo()
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(null)
    vi.spyOn(migrationApi, 'inspectIdentityMigration').mockResolvedValue(inventory())
    vi.spyOn(migrationApi, 'prepareIdentityMigration').mockResolvedValue(migration())

    const { output, exits } = await runMigrateJson()

    expect(output).toMatchObject({
      ok: false,
      code: 'migration_commit_required',
      actionRequired: true,
      action: {
        cwd: repo,
        argv: [
          'git',
          'commit',
          '--only',
          '--message',
          `Migrate DeepSpace app identity to ${APP_ID}`,
          '--',
          'wrangler.toml',
        ],
      },
      migration: { legacyAppId: LEGACY_ID, appId: APP_ID, resourceId: LEGACY_ID },
    })
    expect(readFileSync(join(repo, 'wrangler.toml'), 'utf-8')).toContain(
      `DEEPSPACE_APP_ID = "${APP_ID}"`,
    )
    expect(exits).toEqual([2])
  })

  it('migrates legacy worker identity headers in the same commit as the app id', async () => {
    const made = makeRepo()
    repo = made.dir
    writeFileSync(
      join(repo, 'worker.ts'),
      `interface Env {\n  APP_NAME: string\n}\nconst room = \`app:\${env.APP_NAME}\`\nheaders.set('x-app-name', env.APP_NAME)\n`,
    )
    writeFileSync(join(repo, 'deepspace.migrations.json'), '[]\n')
    execFileSync('git', ['add', 'worker.ts', 'deepspace.migrations.json'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'legacy worker'], { cwd: repo })
    const oid = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim()
    arrangeRepo(repo, oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(null)
    vi.spyOn(migrationApi, 'inspectIdentityMigration').mockResolvedValue(inventory())
    vi.spyOn(migrationApi, 'prepareIdentityMigration').mockResolvedValue(migration())

    const { output, exits } = await runMigrateJson()

    expect(output).toMatchObject({
      ok: false,
      code: 'migration_commit_required',
      action: {
        argv: expect.arrayContaining(['worker.ts', 'wrangler.toml']),
      },
    })
    const worker = readFileSync(join(repo, 'worker.ts'), 'utf-8')
    expect(worker).toContain('DEEPSPACE_APP_ID: string')
    expect(worker).toContain("headers.set('x-app-id', env.DEEPSPACE_APP_ID)")
    expect(worker).toContain('const room = `app:${env.APP_NAME}`')
    expect(exits).toEqual([2])
  })

  it('migrates a tracked pre-id checkout from its matching Worker and APP_NAME', async () => {
    const made = makeRepo()
    repo = made.dir
    const source = readFileSync(join(repo, 'wrangler.toml'), 'utf-8')
      .replace('DEEPSPACE_APP_ID = "deepdotspace-site"\n', '')
      .replace('[vars]\n', '[vars]\nAPP_NAME = "deepdotspace-site"\n')
    writeFileSync(join(repo, 'wrangler.toml'), source)
    execFileSync('git', ['add', 'wrangler.toml'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'legacy config'], { cwd: repo })
    const oid = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim()
    arrangeRepo(repo, oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(null)
    vi.spyOn(migrationApi, 'inspectIdentityMigration').mockResolvedValue(inventory())
    vi.spyOn(migrationApi, 'prepareIdentityMigration').mockResolvedValue(migration())

    const { output } = await runMigrateJson()

    expect(output).toMatchObject({ code: 'migration_commit_required' })
    expect(readFileSync(join(repo, 'wrangler.toml'), 'utf-8')).toContain(
      `DEEPSPACE_APP_ID = "${APP_ID}"`,
    )
  })

  it('commits the registry cutover only after GitHub advertises the exact migration commit', async () => {
    const made = makeRepo(APP_ID)
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(migration())
    const commit = vi
      .spyOn(migrationApi, 'commitIdentityMigration')
      .mockResolvedValue(migration('committed'))

    const { output, exits } = await runMigrateJson()

    expect(commit).toHaveBeenCalledWith(expect.any(String), 'token', APP_ID, {
      commitOid: made.oid,
      branch: 'main',
    })
    expect(output).toMatchObject({
      ok: false,
      code: 'migration_deploy_required',
      actionRequired: true,
      action: { cwd: repo, argv: ['deepspace', 'deploy'] },
    })
    expect(exits).toEqual([2])
  })

  it('does not cut over while GitHub is behind local HEAD', async () => {
    const made = makeRepo(APP_ID)
    repo = made.dir
    arrangeRepo(repo, 'b'.repeat(40))
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(migration())
    const commit = vi.spyOn(migrationApi, 'commitIdentityMigration')

    const { output, exits } = await runMigrateJson()

    expect(commit).not.toHaveBeenCalled()
    expect(output).toMatchObject({
      ok: false,
      code: 'github_push_required',
      actionRequired: true,
      action: { cwd: repo, argv: ['git', 'push', 'origin', 'main'] },
    })
    expect(exits).toEqual([2])
  })

  it('never deploys a legacy-valued checkout after the registry has cut over', async () => {
    const made = makeRepo()
    repo = made.dir
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(migration('committed'))
    const inspect = vi.spyOn(migrationApi, 'inspectIdentityMigration')
    const commit = vi.spyOn(migrationApi, 'commitIdentityMigration')

    const { output, exits } = await runMigrateJson()

    expect(output).toMatchObject({
      ok: false,
      code: 'migration_config_stale',
      migration: { legacyAppId: LEGACY_ID, appId: APP_ID, status: 'committed' },
    })
    expect(inspect).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })

  it('stages cancellation by restoring the legacy id before touching the server journal', async () => {
    const made = makeRepo(APP_ID)
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(migration())
    const cancel = vi.spyOn(migrationApi, 'cancelIdentityMigration')

    const { output, exits } = await runMigrateJson({ cancel: true })

    expect(output).toMatchObject({
      ok: false,
      code: 'migration_restore_commit_required',
      action: {
        cwd: repo,
        argv: [
          'git',
          'commit',
          '--only',
          '--message',
          `Restore DeepSpace app identity to ${LEGACY_ID}`,
          '--',
          'wrangler.toml',
        ],
      },
    })
    expect(readFileSync(join(repo, 'wrangler.toml'), 'utf-8')).toContain(
      `DEEPSPACE_APP_ID = "${LEGACY_ID}"`,
    )
    expect(cancel).not.toHaveBeenCalled()
    expect(exits).toEqual([2])
  })

  it('cancels a prepared journal only after the restored legacy config is on GitHub', async () => {
    const made = makeRepo()
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(migration())
    const cancel = vi.spyOn(migrationApi, 'cancelIdentityMigration').mockResolvedValue()

    const { output, exits } = await runMigrateJson({ cancel: true })

    expect(cancel).toHaveBeenCalledWith(expect.any(String), 'token', LEGACY_ID)
    expect(output).toMatchObject({ ok: true, status: 'cancelled', legacyAppId: LEGACY_ID })
    expect(exits).toEqual([0])
  })

  it('keeps a committed migration forward-only when cancellation is requested', async () => {
    const made = makeRepo(APP_ID)
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(migration('committed'))
    const cancel = vi.spyOn(migrationApi, 'cancelIdentityMigration')

    const { output, exits } = await runMigrateJson({ cancel: true })

    expect(output).toMatchObject({ ok: false, code: 'forward_recovery_required' })
    expect(cancel).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })

  it('verifies a committed migration after its migration manifest is live', async () => {
    const made = makeRepo(APP_ID)
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(migration('committed'))
    const verify = vi
      .spyOn(migrationApi, 'verifyIdentityMigration')
      .mockResolvedValue(migration('verified'))

    const { output, exits } = await runMigrateJson()

    expect(verify).toHaveBeenCalledWith(expect.any(String), 'token', APP_ID)
    expect(output).toMatchObject({
      ok: true,
      status: 'verified',
      migration: { legacyAppId: LEGACY_ID, appId: APP_ID, status: 'verified' },
    })
    expect(exits).toEqual([0])
  })

  it('does not verify from a migration manifest deployed before the identity cutover', async () => {
    const made = makeRepo(APP_ID)
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(migration('committed'))
    vi.mocked(repoApiModule.repoApi).mockReturnValue({
      latestRelease: vi.fn().mockResolvedValue({
        release: {
          commitOid: null,
          createdAt: '2026-08-03T00:00:30.000Z',
          config: { appMigrations: [SOURCE_MIGRATION_ID] },
        },
      }),
    } as never)
    const verify = vi.spyOn(migrationApi, 'verifyIdentityMigration')

    const { output, exits } = await runMigrateJson()

    expect(output).toMatchObject({ ok: false, code: 'migration_deploy_required' })
    expect(verify).not.toHaveBeenCalled()
    expect(exits).toEqual([2])
  })

  it('reopens a rolled-back migration with the same reserved identity', async () => {
    const made = makeRepo()
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(migration('rolled_back'))
    vi.spyOn(migrationApi, 'inspectIdentityMigration').mockResolvedValue(inventory())
    const prepare = vi
      .spyOn(migrationApi, 'prepareIdentityMigration')
      .mockResolvedValue(migration('prepared'))

    const { output, exits } = await runMigrateJson()

    expect(prepare).toHaveBeenCalledWith(expect.any(String), 'token', LEGACY_ID, {
      destinationAppId: APP_ID,
      repository: REPOSITORY,
      expectedSourceRevision: 1,
    })
    expect(output).toMatchObject({ ok: false, code: 'migration_commit_required' })
    expect(readFileSync(join(repo, 'wrangler.toml'), 'utf-8')).toContain(
      `DEEPSPACE_APP_ID = "${APP_ID}"`,
    )
    expect(exits).toEqual([2])
  })

  it('reports modern apps without creating a migration', async () => {
    const made = makeRepo(APP_ID)
    repo = made.dir
    arrangeRepo(repo, made.oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(null)

    const { output, exits } = await runMigrateJson()
    expect(output).toMatchObject({ ok: true, status: 'up_to_date', appId: APP_ID })
    expect(exits).toEqual([0])
  })

  it('applies future source migrations even when app identity is already modern', async () => {
    const made = makeRepo(APP_ID)
    repo = made.dir
    writeFileSync(
      join(repo, 'worker.ts'),
      `interface Env {\n  APP_NAME: string\n}\nheaders.set('x-app-name', env.APP_NAME)\n`,
    )
    writeFileSync(join(repo, 'deepspace.migrations.json'), '[]\n')
    execFileSync('git', ['add', 'worker.ts', 'deepspace.migrations.json'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'legacy worker'], { cwd: repo })
    const oid = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim()
    arrangeRepo(repo, oid)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(null)

    const { output, exits } = await runMigrateJson()

    expect(output).toMatchObject({
      ok: false,
      code: 'migration_commit_required',
      action: {
        argv: [
          'git',
          'commit',
          '--only',
          '--message',
          'Apply DeepSpace app migrations',
          '--',
          'deepspace.migrations.json',
          'worker.ts',
        ],
      },
      sourceMigrations: [expect.objectContaining({ id: '2026-08-canonical-app-identity-wire' })],
    })
    expect(readFileSync(join(repo, 'worker.ts'), 'utf-8')).toContain(
      "headers.set('x-app-id', env.DEEPSPACE_APP_ID)",
    )
    expect(JSON.parse(readFileSync(join(repo, 'deepspace.migrations.json'), 'utf-8'))).toEqual([
      SOURCE_MIGRATION_ID,
    ])
    expect(exits).toEqual([2])
  })

  it('requires deploy while the live release lacks an applied source migration', async () => {
    const made = makeRepo(APP_ID)
    repo = made.dir
    writeFileSync(
      join(repo, 'worker.ts'),
      `interface Env {\n  APP_NAME: string\n  DEEPSPACE_APP_ID: string\n}\nheaders.set('x-app-id', env.DEEPSPACE_APP_ID)\n`,
    )
    execFileSync('git', ['add', 'worker.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'current worker'], { cwd: repo })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim()
    arrangeRepo(repo, head)
    vi.spyOn(migrationApi, 'getIdentityMigration').mockResolvedValue(null)
    vi.mocked(repoApiModule.repoApi).mockReturnValue({
      latestRelease: vi.fn().mockResolvedValue({
        release: { commitOid: null, config: { appMigrations: [] } },
      }),
    } as never)

    const { output, exits } = await runMigrateJson()

    expect(output).toMatchObject({
      ok: false,
      code: 'migration_deploy_required',
      actionRequired: true,
      action: { cwd: repo, argv: ['deepspace', 'deploy'] },
      appId: APP_ID,
      sourceMigrations: [SOURCE_MIGRATION_ID],
    })
    expect(exits).toEqual([2])
  })
})
