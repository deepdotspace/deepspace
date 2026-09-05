/** Deploy CLI decision and request helpers, imported from their owning modules. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as p from '@clack/prompts'
import {
  blankSelectorRefusal,
  forbiddenDeployMessage,
  ownerJwtMissingRefusal,
  pendingRename,
  renamePromptMessage,
  renameRefusalMessage,
  staleBaseGuardFields,
  shippedSourceEvidence,
} from '../deploy'
import { acquireDeployLock, deployLockPath } from '../deploy/lock'
import { MAX_DEPLOY_ASSET_FILE_BYTES } from '../../../shared/app-files'
import {
  collectAssets,
  collectWorkerBundle,
  extractRunWorkerFirst,
  clientAppIdRefusal,
  isDeployAssetControlFile,
  oversizedAssetRefusal,
  readDeployAssetConfig,
  resolveDeployRunWorkerFirst,
  type DeployAsset,
  type DeployWorkerBundle,
} from '../deploy/build'
import {
  ASSET_UPLOAD_ATTEMPTS,
  ASSET_UPLOAD_ATTEMPT_TIMEOUT_MS,
  assetManifest,
  deployBuiltBundle,
  formatDeployWorkerError,
  isDeployServiceResourceLimit,
  postWithRetry,
  STALE_DISPLAY_NAME_LOCATIONS,
  uploadDeployAssets,
} from '../deploy/request'
import {
  deployRepositoryFailure,
  dirtyWorktreeRefusal,
  detachedHeadRefusal,
  preflightDeployRepository,
  pushWithTransientRetry,
  shouldSendLineage,
  syncDeployRepository,
  workspaceDeployLineage,
} from '../deploy/repository'
import { createDeployOutput, deployFailureEnvelope, type DeployOutput } from '../deploy/output'
import { CliExit } from '../../lib/cli-errors'
import type { PushRefResult } from '../../lib/vc-push'
import { ApiError } from '../../lib/api'
import { GitError } from '../../lib/git/process'
import { loadDeploySecrets } from '../deploy/secrets'
import { writeDevVars } from '../../lib/dev-vars'

vi.mock('../../lib/dev-vars', () => ({ writeDevVars: vi.fn(async () => undefined) }))

describe('deploy failure JSON envelope', () => {
  it('keeps refusal details from overriding reserved control fields', () => {
    expect(
      deployFailureEnvelope('locked', 'deploy_in_progress', {
        actionRequired: true,
        extra: {
          ok: true,
          code: 'wrong',
          action: { cwd: '/tmp', argv: ['evil'] },
          lockPath: '/app/.deepspace/deploy.lock',
        },
      }),
    ).toEqual({
      ok: false,
      code: 'deploy_in_progress',
      error: 'locked',
      actionRequired: true,
      lockPath: '/app/.deepspace/deploy.lock',
    })
  })
})

describe('extractRunWorkerFirst', () => {
  it('forwards documentation routes only when the app declares them', () => {
    expect(extractRunWorkerFirst({})).toEqual([])
    expect(extractRunWorkerFirst({ assets: { run_worker_first: ['/docs', '/docs/*'] } })).toEqual([
      '/docs',
      '/docs/*',
    ])
  })

  it('filters platform-reserved, invalid, and duplicate routes', () => {
    expect(
      extractRunWorkerFirst({
        assets: {
          run_worker_first: ['/api/*', '/docs', '/docs', 'not-a-route', '/oauth/*'],
        },
      }),
    ).toEqual(['/docs', '/oauth/*'])
  })

  it('uses only the environment-resolved Wrangler routing contract', () => {
    expect(resolveDeployRunWorkerFirst({})).toEqual([])
    expect(resolveDeployRunWorkerFirst({ assets: { run_worker_first: true } })).toBe(true)
    expect(
      resolveDeployRunWorkerFirst({ assets: { run_worker_first: ['/docs', '/docs/*'] } }),
    ).toEqual(['/docs', '/docs/*'])
  })
})

describe('static asset control files', () => {
  it('moves Cloudflare control files into deploy metadata instead of public assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepspace-asset-config-'))
    try {
      writeFileSync(join(dir, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n')
      writeFileSync(join(dir, '_redirects'), '/old /new 301\n')
      expect(readDeployAssetConfig(dir)).toEqual({
        _headers: '/*\n  X-Content-Type-Options: nosniff\n',
        _redirects: '/old /new 301\n',
      })
      expect(isDeployAssetControlFile('_headers')).toBe(true)
      expect(isDeployAssetControlFile('_redirects')).toBe(true)
      expect(isDeployAssetControlFile('index.html')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The build-preview `.dev.vars` delete moved to `src/build/plugin.ts` — one
// implementation for the plugin sweep and this deploy path — and its tests
// moved with it (`src/build/__tests__/build-dev-vars.test.ts`).

describe('blankSelectorRefusal (pre-auth blank deploy selector)', () => {
  // A present-but-blank target selector is refused pre-auth with a true code so an
  // unset `--env "$VAR"` can't silently deploy prod, nor `deploy "$DIR"` the cwd.
  it('refuses an explicitly-blank/whitespace --env as invalid_env', () => {
    expect(blankSelectorRefusal({ env: '' })?.code).toBe('invalid_env')
    expect(blankSelectorRefusal({ env: '   ' })?.code).toBe('invalid_env')
  })
  it('refuses an explicitly-blank/whitespace dir as invalid_dir', () => {
    expect(blankSelectorRefusal({ dir: '' })?.code).toBe('invalid_dir')
    expect(blankSelectorRefusal({ dir: '  ' })?.code).toBe('invalid_dir')
  })
  it('allows an omitted or real selector (undefined → documented default)', () => {
    expect(blankSelectorRefusal({})).toBeNull()
    expect(blankSelectorRefusal({ env: 'staging', dir: 'apps/web' })).toBeNull()
  })
})

/**
 * Both refusals used to fire at commit time — after a full build and a
 * multi-hundred-KiB upload. They are answered by the pre-build `/source`
 * response, so the CLI settles them before `buildDeployBundle` runs.
 */
describe('external git source is selected from first-release evidence', () => {
  // The `source_unclaimed` fork-in-the-road is gone: an unclaimed app whose
  // checkout points at GitHub deploys as GitHub without a manual declaration
  // or git gates; the successful first release latches that evidence.
  it('skips every git gate for an unclaimed app with a GitHub remote, even dirty', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-deploy-inferred-'))
    try {
      const g = (args: string[]) => execFileSync('git', args, { cwd: repo })
      g(['init', '-q', '-b', 'main'])
      g(['remote', 'add', 'origin', 'git@github.com:acme/app.git'])
      writeFileSync(join(repo, 'wip.txt'), 'uncommitted deploy bytes\n')

      expect(preflightDeployRepository({ appDir: repo, push: true, source: null })).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('still runs the DeepSpace gates for an unclaimed app with no GitHub remote', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-deploy-native-'))
    try {
      const g = (args: string[]) => execFileSync('git', args, { cwd: repo })
      g(['init', '-q', '-b', 'main'])
      g(['config', 'user.email', 'test@example.com'])
      g(['config', 'user.name', 'Test'])
      writeFileSync(join(repo, 'f.txt'), 'base\n')
      g(['add', '-A'])
      g(['commit', '-q', '-m', 'base'])
      writeFileSync(join(repo, 'f.txt'), 'dirty\n')

      expect(preflightDeployRepository({ appDir: repo, push: true, source: null })).toMatchObject({
        code: 'dirty_worktree',
      })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('pre-build deploy refusals', () => {
  it('refuses a collaborator whose app has no live APP_OWNER_JWT, with the platform’s sentence', () => {
    const refusal = ownerJwtMissingRefusal({
      onBehalf: { ownerJwtLive: false },
      registeredHost: 'victim-app.app.space',
    })
    expect(refusal?.code).toBe('owner_jwt_missing')
    // Pinned by tests/docker/collaborators.sh and by the deploy worker's own 409.
    expect(refusal?.error).toBe(
      'Cannot preserve the existing secrets: this app has no live deployment ' +
        'carrying an APP_OWNER_JWT. Ask the owner to redeploy.',
    )
  })

  it('tells a collaborator on a NEVER-deployed app the truth: the owner deploys once first', () => {
    // "Ask the owner to redeploy" named an act that had never happened, and
    // "existing secrets" that did not exist (v0.26.0 collab AX BUG-2) — the
    // collaborator-first path this release opened needs its own sentence.
    const refusal = ownerJwtMissingRefusal({
      onBehalf: { ownerJwtLive: false },
      registeredHost: null,
    })
    expect(refusal?.code).toBe('owner_jwt_missing')
    expect(refusal?.error).toContain('never been deployed')
    expect(refusal?.error).toContain('The owner must run `deepspace deploy` first')
  })

  it('lets an owner, a live-JWT collaborator, and an unanswering platform through', () => {
    // The owner branch omits onBehalf entirely; an older platform omits it too.
    // Unknown must never read as "missing" — the server still guards it.
    expect(ownerJwtMissingRefusal({})).toBeNull()
    expect(ownerJwtMissingRefusal({ onBehalf: { ownerJwtLive: true } })).toBeNull()
  })

  it('sees a rename when the wrangler name no longer matches the served host', () => {
    expect(pendingRename('old-name.app.space', 'new-name')).toEqual({
      fromHost: 'old-name.app.space',
      toHost: 'new-name.app.space',
    })
  })

  it('sees no rename on an unchanged name or an app that has never been deployed', () => {
    expect(pendingRename('same.app.space', 'same')).toBeNull()
    expect(pendingRename(null, 'fresh')).toBeNull()
    // An older platform sends no host at all: leave it to the server.
    expect(pendingRename(undefined, 'fresh')).toBeNull()
  })

  it('names both hosts and both escapes, matching the server’s rename_required', () => {
    const rename = { fromHost: 'old-name.app.space', toHost: 'new-name.app.space' }
    for (const message of [renameRefusalMessage(rename), renamePromptMessage(rename)]) {
      expect(message).toContain(
        'This deploy renames the app: old-name.app.space → new-name.app.space',
      )
      expect(message).toContain('deepspace app init --new-id')
    }
    expect(renameRefusalMessage(rename)).toContain('--rename')
  })

  it('tells BOTH surfaces that the display name does not travel, naming every stale location', () => {
    // The non-TTY refusal is the only rename sentence an unattended agent ever
    // reads; it used to be the one that omitted this. Both must name both
    // files, or a renamed app keeps serving its old name in its own nav and in
    // the worker's env.APP_NAME with nothing saying so.
    const rename = { fromHost: 'old-name.app.space', toHost: 'new-name.app.space' }
    expect(STALE_DISPLAY_NAME_LOCATIONS).toEqual([
      'src/constants.ts:APP_NAME',
      'wrangler.toml:[vars].APP_NAME',
    ])
    for (const message of [renameRefusalMessage(rename), renamePromptMessage(rename)]) {
      expect(message).toContain('display name')
      for (const location of STALE_DISPLAY_NAME_LOCATIONS) expect(message).toContain(location)
    }
  })
})

describe('on-behalf deploy attribution', () => {
  const SILENT_SPINNER = { start: vi.fn(), stop: vi.fn(), message: vi.fn() }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends every generated Worker module with its relative import path', async () => {
    vi.spyOn(p.log, 'info').mockImplementation(() => {})
    let commitForm: FormData | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/api/health')) {
          return Response.json({
            capabilities: {
              assetTransport: 'content-addressed-v1',
              workerModules: 'multipart-v1',
            },
          })
        }
        if (String(url).endsWith('/asset-plan')) return Response.json({ missing: [] })
        commitForm = init?.body as FormData
        return Response.json({ success: true, url: 'https://example.app.space' })
      }),
    )
    const worker: DeployWorkerBundle = {
      main: 'index.js',
      modules: [
        { name: 'index.js', content: 'import "./assets/rolldown-runtime.js"' },
        { name: 'assets/rolldown-runtime.js', content: 'export const runtime = true' },
      ],
    }

    await deployBuiltBundle({
      deployUrl: 'https://deploy.test',
      appDir: '/tmp',
      appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
      appName: 'example',
      token: 'tok',
      rename: false,
      claimReleased: false,
      ignoreStale: false,
      bundle: {
        assets: [],
        assetConfig: {},
        worker,
        appMigrations: [],
        doManifest: undefined,
        customBindings: [],
        extraRoutes: [],
        compatibilityDate: null,
        compatibilityFlags: [],
        notFoundHandling: null,
      },
      secretsConfig: 'prd',
      envName: undefined,
      repository: {
        commitOid: null,
        recoverable: false,
        deployKey: 'key',
        source: null,
        sourceRevision: 0,
        branch: 'main',
        dirty: false,
        observedRepository: null,
      },
      output: {
        json: true,
        nonInteractive: true,
        emitJson: vi.fn(),
        showIntro: vi.fn(),
        die(message, code): never {
          throw new Error(`${code}: ${message}`)
        },
      },
      spinner: SILENT_SPINNER,
    })

    expect(commitForm).not.toBeNull()
    expect(commitForm!.get('workerMain')).toBe('index.js')
    expect(commitForm!.get('workerModules')).toBe('["assets/rolldown-runtime.js"]')
    expect(await (commitForm!.get('worker') as Blob).text()).toBe(worker.modules[0].content)
    expect(await (commitForm!.get('workerModule') as Blob).text()).toBe(worker.modules[1].content)
  })

  it('refreshes an expired bearer and rebuilds the idempotent commit request once', async () => {
    vi.spyOn(p.log, 'info').mockImplementation(() => {})
    const refreshToken = vi.fn(async () => 'fresh-token')
    const commitAuthorizations: string[] = []
    const commitBodies: FormData[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/api/health')) {
          return Response.json({ capabilities: { assetTransport: 'content-addressed-v1' } })
        }
        if (String(url).endsWith('/asset-plan')) return Response.json({ missing: [] })
        commitAuthorizations.push(new Headers(init?.headers).get('Authorization') ?? '')
        commitBodies.push(init?.body as FormData)
        return commitAuthorizations.at(-1) === 'Bearer expired-token'
          ? Response.json({ error: 'Invalid or expired token' }, { status: 401 })
          : Response.json({ success: true, url: 'https://example.app.space' })
      }),
    )

    const body = await deployBuiltBundle({
      deployUrl: 'https://deploy.test',
      appDir: '/tmp',
      appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
      appName: 'example',
      token: 'expired-token',
      refreshToken,
      rename: false,
      claimReleased: false,
      ignoreStale: false,
      bundle: {
        assets: [],
        assetConfig: {},
        worker: {
          main: 'index.js',
          modules: [{ name: 'index.js', content: 'export default {}' }],
        },
        appMigrations: [],
        doManifest: undefined,
        customBindings: [],
        extraRoutes: [],
        compatibilityDate: null,
        compatibilityFlags: [],
        notFoundHandling: null,
      },
      secretsConfig: 'prd',
      envName: undefined,
      repository: {
        commitOid: null,
        recoverable: false,
        deployKey: 'stable-deploy-key',
        source: null,
        sourceRevision: 0,
        branch: 'main',
        dirty: false,
        observedRepository: null,
      },
      output: {
        json: true,
        nonInteractive: true,
        emitJson: vi.fn(),
        showIntro: vi.fn(),
        die(message, code): never {
          throw new Error(`${code}: ${message}`)
        },
      },
      spinner: SILENT_SPINNER,
    })

    expect(body.success).toBe(true)
    expect(refreshToken).toHaveBeenCalledOnce()
    expect(commitAuthorizations).toEqual(['Bearer expired-token', 'Bearer fresh-token'])
    expect(commitBodies).toHaveLength(2)
    expect(commitBodies[0]).not.toBe(commitBodies[1])
    expect(commitBodies.map((form) => form.get('deployKey'))).toEqual([
      'stable-deploy-key',
      'stable-deploy-key',
    ])
  })

  it('preserves an auth-service outage after a commit rejects the bearer', async () => {
    vi.spyOn(p.log, 'info').mockImplementation(() => {})
    const authError = new ApiError('auth service unavailable', 503, 'auth_service_unavailable')
    const emitJson = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/api/health')) {
          return Response.json({ capabilities: { assetTransport: 'content-addressed-v1' } })
        }
        if (String(url).endsWith('/asset-plan')) return Response.json({ missing: [] })
        return Response.json({ error: 'Invalid or expired token' }, { status: 401 })
      }),
    )

    await expect(
      deployBuiltBundle({
        deployUrl: 'https://deploy.test',
        appDir: '/tmp',
        appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
        appName: 'example',
        token: 'expired-token',
        refreshToken: async () => {
          throw authError
        },
        rename: false,
        claimReleased: false,
        ignoreStale: false,
        bundle: {
          assets: [],
          assetConfig: {},
          worker: {
            main: 'index.js',
            modules: [{ name: 'index.js', content: 'export default {}' }],
          },
          appMigrations: [],
          doManifest: undefined,
          customBindings: [],
          extraRoutes: [],
          compatibilityDate: null,
          compatibilityFlags: [],
          notFoundHandling: null,
        },
        secretsConfig: 'prd',
        envName: undefined,
        repository: {
          commitOid: null,
          recoverable: false,
          deployKey: 'stable-deploy-key',
          source: null,
          sourceRevision: 0,
          branch: 'main',
          dirty: false,
          observedRepository: null,
        },
        output: {
          json: true,
          nonInteractive: true,
          emitJson,
          showIntro: vi.fn(),
          die(message, code, opts = {}): never {
            // Model the real exit door (deploy/output.ts): envelope out,
            // CliExit up — bail() now delegates here instead of hand-rolling.
            this.emitJson(deployFailureEnvelope(message, code, opts))
            throw new CliExit(opts.actionRequired ? 2 : 1)
          },
        },
        spinner: SILENT_SPINNER,
      }),
    ).rejects.toMatchObject({ exitCode: 1 })
    expect(emitJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: 'auth_service_unavailable',
        error: 'auth service unavailable',
      }),
    )
  })

  it('says nothing about attribution: the ledger records the COLLABORATOR as actor', async () => {
    // The deploy worker keeps `identity.userId` as the caller and overrides
    // only `ownerUserId`, so the release's `actor` — and `status`'s `byYou` —
    // are the collaborator's. The old warning claimed the opposite.
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {})
    vi.spyOn(p.log, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/api/health')) {
          return Response.json({ capabilities: { assetTransport: 'content-addressed-v1' } })
        }
        if (String(url).endsWith('/asset-plan')) return Response.json({ missing: [] })
        return Response.json({
          success: true,
          url: 'https://app.example.invalid',
          releaseId: 'rel_1',
          onBehalfOfOwner: 'usr_owner',
        })
      }),
    )

    const body = await deployBuiltBundle({
      deployUrl: 'https://deploy.test',
      appDir: '/tmp',
      appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
      appName: 'example',
      token: 'tok',
      rename: false,
      claimReleased: false,
      ignoreStale: false,
      bundle: {
        assets: [],
        assetConfig: {},
        worker: {
          main: 'index.js',
          modules: [{ name: 'index.js', content: 'export default {}' }],
        },
        appMigrations: [],
        doManifest: undefined,
        customBindings: [],
        extraRoutes: [],
        compatibilityDate: null,
        compatibilityFlags: [],
        notFoundHandling: null,
      },
      secretsConfig: 'prd',
      envName: undefined,
      repository: {
        commitOid: null,
        recoverable: false,
        deployKey: 'key',
        source: null,
        sourceRevision: 0,
        branch: 'main',
        dirty: false,
        observedRepository: null,
      },
      output: {
        json: true,
        nonInteractive: true,
        emitJson: vi.fn(),
        showIntro: vi.fn(),
        die(message, code): never {
          throw new Error(`${code}: ${message}`)
        },
      },
      spinner: SILENT_SPINNER,
    })

    expect(body.success).toBe(true)
    for (const call of warn.mock.calls) {
      expect(String(call[0])).not.toContain('attributed')
    }
  })

  it('release_in_progress is the "retry" tier: advice sentence, exit 2, the same deploy as the action', async () => {
    vi.spyOn(p.log, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/api/health')) {
          return Response.json({ capabilities: { assetTransport: 'content-addressed-v1' } })
        }
        if (String(url).endsWith('/asset-plan')) return Response.json({ missing: [] })
        return Response.json(
          { error: 'Another deploy is already prepared for this app', code: 'release_in_progress' },
          { status: 409 },
        )
      }),
    )
    const emitJson = vi.fn()
    const argv = process.argv
    process.argv = [argv[0], argv[1], 'deploy', '--json']
    let thrown: unknown
    try {
      await deployBuiltBundle({
        deployUrl: 'https://deploy.test',
        appDir: '/tmp',
        appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
        appName: 'example',
        token: 'tok',
        rename: false,
        claimReleased: false,
        ignoreStale: false,
        bundle: {
          assets: [],
          assetConfig: {},
          worker: {
            main: 'index.js',
            modules: [{ name: 'index.js', content: 'export default {}' }],
          },
          appMigrations: [],
          doManifest: undefined,
          customBindings: [],
          extraRoutes: [],
          compatibilityDate: null,
          compatibilityFlags: [],
          notFoundHandling: null,
        },
        secretsConfig: 'prd',
        envName: undefined,
        repository: {
          commitOid: null,
          recoverable: false,
          deployKey: 'key',
          source: null,
          sourceRevision: 0,
          branch: 'main',
          dirty: false,
          observedRepository: null,
        },
        output: {
          json: true,
          nonInteractive: true,
          emitJson,
          showIntro: vi.fn(),
          die(message, code, opts = {}): never {
            // Model the real exit door (deploy/output.ts): envelope out,
            // CliExit up — bail() now delegates here instead of hand-rolling.
            this.emitJson(deployFailureEnvelope(message, code, opts))
            throw new CliExit(opts.actionRequired ? 2 : 1)
          },
        },
        spinner: SILENT_SPINNER,
      })
    } catch (e) {
      thrown = e
    } finally {
      process.argv = argv
    }
    expect(thrown).toMatchObject({ exitCode: 2 })
    expect(emitJson).toHaveBeenCalledTimes(1)
    const envelope = emitJson.mock.calls[0][0] as Record<string, unknown>
    expect(envelope).toMatchObject({
      ok: false,
      code: 'release_in_progress',
      actionRequired: true,
      action: { cwd: process.cwd(), argv: ['deepspace', 'deploy', '--json'] },
    })
    expect(String(envelope.error)).toMatch(/Wait a moment and run the same deploy again/)
  })
})

describe('deploy secret authority', () => {
  const appId = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'

  function output(): DeployOutput {
    return {
      json: true,
      nonInteractive: true,
      emitJson: vi.fn(),
      showIntro: vi.fn(),
      die(message, code, options): never {
        const error = new Error(message) as Error & {
          code?: string
          options?: unknown
        }
        error.code = code
        error.options = options
        throw error
      },
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(writeDevVars).mockClear()
  })

  it('materializes empty locally but refuses deploy when the config is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'config_not_found' }, { status: 404 })),
    )

    const result = loadDeploySecrets({
      deployUrl: 'https://deploy.test',
      appDir: '/tmp/app',
      appId,
      envName: undefined,
      ownerId: 'owner',
      token: 'token',
      output: output(),
    })

    await expect(result).rejects.toMatchObject({
      code: 'secrets_config_missing',
      options: {
        action: {
          cwd: '/tmp/app',
          argv: ['deepspace', 'secrets', 'configs', 'create', 'prd'],
        },
      },
    })
    expect(writeDevVars).toHaveBeenCalledWith(
      '/tmp/app',
      'owner',
      'token',
      undefined,
      expect.objectContaining({
        generatedSecretsCache: `# App secrets · config prd · app ${appId}`,
      }),
    )
  })

  it('the empty-set removal warning prints for an existing empty config — and NEVER on the refusal path', async () => {
    // The warn line and the 404 refusal are contradictory sentences; the
    // gate between them vanished once without a test noticing. Pin both
    // directions: 200-empty (ships authoritative-empty) warns; 404
    // (refuses, deploys nothing, removes nothing) must not.
    const { log } = await import('@clack/prompts')
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ secrets: {} })),
      )
      await loadDeploySecrets({
        deployUrl: 'https://deploy.test',
        appDir: '/tmp/app',
        appId,
        envName: undefined,
        ownerId: 'owner',
        token: 'token',
        output: output(),
      })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0][0])).toContain('App secrets: none')

      warnSpy.mockClear()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ error: 'config_not_found' }, { status: 404 })),
      )
      await expect(
        loadDeploySecrets({
          deployUrl: 'https://deploy.test',
          appDir: '/tmp/app',
          appId,
          envName: undefined,
          ownerId: 'owner',
          token: 'token',
          output: output(),
        }),
      ).rejects.toMatchObject({ code: 'secrets_config_missing' })
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('a dev-vars/app-token failure keeps its own code — never secrets_refresh_failed', async () => {
    // The catch split is the point: an agent branching on
    // secrets_refresh_failed would go create a secrets config for what is
    // actually an auth or wrong-URL fault. An ApiError keeps its server
    // code; anything else gets dev_vars_failed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ secrets: { API_KEY: 'v1' } })),
    )
    vi.mocked(writeDevVars).mockRejectedValueOnce(
      new ApiError('App not found', 404, 'app_not_found'),
    )
    await expect(
      loadDeploySecrets({
        deployUrl: 'https://deploy.test',
        appDir: '/tmp/app',
        appId,
        envName: undefined,
        ownerId: 'owner',
        token: 'token',
        output: output(),
      }),
    ).rejects.toMatchObject({ code: 'app_not_found' })

    vi.mocked(writeDevVars).mockRejectedValueOnce(new Error('EACCES: permission denied'))
    await expect(
      loadDeploySecrets({
        deployUrl: 'https://deploy.test',
        appDir: '/tmp/app',
        appId,
        envName: undefined,
        ownerId: 'owner',
        token: 'token',
        output: output(),
      }),
    ).rejects.toMatchObject({ code: 'dev_vars_failed' })
  })

  it('resolves an existing config to the name the deploy form sends', async () => {
    // No values travel: the platform reads its own store at commit; the CLI's
    // whole contribution is the config name (wranglerEnv ?? 'prd').
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ secrets: {} })),
    )
    const result = await loadDeploySecrets({
      deployUrl: 'https://deploy.test',
      appDir: '/tmp/app',
      appId,
      envName: undefined,
      ownerId: 'owner',
      token: 'token',
      output: output(),
    })
    expect(result).toEqual({ configName: 'prd' })
  })
})

describe('content-addressed asset collection', () => {
  it('addresses every built file by the SHA-256 of its bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepspace-assets-'))
    try {
      writeFileSync(join(dir, 'index.html'), '<html/>')
      mkdirSync(join(dir, 'nested'))
      writeFileSync(join(dir, 'nested', 'app.js'), 'console.log(1)')
      // Control files are metadata, never public assets.
      writeFileSync(join(dir, '_headers'), '/*\n  X-Frame-Options: DENY\n')

      const assets = collectAssets(dir)
      expect(assets.map((asset) => asset.path).sort()).toEqual(['/index.html', '/nested/app.js'])
      for (const asset of assets) {
        const bytes = readFileSync(asset.sourcePath)
        expect(asset.hash).toBe(createHash('sha256').update(bytes).digest('hex'))
        expect(asset.size).toBe(bytes.byteLength)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives identical content one hash, so the manifest dedupes on the wire', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepspace-assets-dup-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'same bytes')
      writeFileSync(join(dir, 'b.txt'), 'same bytes')
      const manifest = assetManifest(collectAssets(dir))
      expect(manifest).toHaveLength(2)
      expect(new Set(manifest.map((entry) => entry.hash)).size).toBe(1)
      // The manifest carries no file contents at all.
      expect(JSON.stringify(manifest)).not.toMatch(/same bytes/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Worker module collection', () => {
  it('collects the entry and every emitted server chunk while excluding client assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepspace-worker-modules-'))
    try {
      mkdirSync(join(dir, 'assets'))
      mkdirSync(join(dir, 'client'))
      writeFileSync(join(dir, 'index.js'), 'import "./assets/rolldown-runtime.js"')
      writeFileSync(join(dir, 'assets', 'rolldown-runtime.js'), 'export const runtime = true')
      writeFileSync(join(dir, 'assets', 'ignored.css'), 'body {}')
      writeFileSync(join(dir, 'client', 'browser.js'), 'console.log("client")')

      expect(collectWorkerBundle(dir, join(dir, 'index.js'), join(dir, 'client'))).toEqual({
        main: 'index.js',
        modules: [
          { name: 'index.js', content: 'import "./assets/rolldown-runtime.js"' },
          { name: 'assets/rolldown-runtime.js', content: 'export const runtime = true' },
        ],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a main module outside the generated Worker directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepspace-worker-main-'))
    const outside = `${dir}-outside.js`
    try {
      writeFileSync(join(dir, 'index.js'), 'export default {}')
      writeFileSync(outside, 'export default {}')
      expect(() => collectWorkerBundle(dir, outside)).toThrow(/outside the generated output/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { force: true })
    }
  })
})

/**
 * The safety net for apps scaffolded before the client app id was injected
 * from wrangler.toml. Those apps still carry `export const APP_ID = 'app_…'`
 * frozen at scaffold time, so `deploy --env staging` builds a worker on
 * staging's rooms and a browser on the default env's — and used to report
 * `ok:true, serving:confirmed` while the two halves read different stores.
 */
describe('clientAppIdRefusal', () => {
  const TARGET = 'app_01JG8QK4M2N7P9RSTVWXYZ0123'
  const OTHER = 'app_01JG8QK4M2N7P9RSTVWXYZ0456'

  function withClient<T>(files: Record<string, string>, fn: (assets: DeployAsset[]) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'deepspace-foreign-id-'))
    try {
      for (const [name, content] of Object.entries(files)) {
        const path = join(dir, name)
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, content)
      }
      return fn(collectAssets(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('passes a bundle built against the id being deployed', () => {
    withClient({ 'app.js': `const a="${TARGET}";console.log(a)` }, (assets) => {
      expect(clientAppIdRefusal(assets, TARGET)).toBeNull()
    })
  })

  it('passes a bundle that names no app id at all', () => {
    withClient({ 'app.js': 'console.log("hi")' }, (assets) => {
      expect(clientAppIdRefusal(assets, TARGET)).toBeNull()
    })
  })

  it('refuses a staging deploy whose client still carries the default id', () => {
    withClient(
      { 'index.html': '<html/>', 'chunk-a1b2.js': `const e="${OTHER}",t=\`app:\${e}\`;` },
      (assets) => {
        const refusal = clientAppIdRefusal(assets, TARGET, 'staging')?.message ?? ''
        expect(refusal).toContain(OTHER)
        expect(refusal).toContain(TARGET)
        expect(refusal).toContain('--env staging')
        // Names the file so the fix is findable, not just the id.
        expect(refusal).toContain('/chunk-a1b2.js')
        expect(refusal).toContain('src/constants.ts')
      },
    )
  })

  it('finds the literal inside minified code and inlined html scripts', () => {
    withClient({ 'index.html': `<script>window.__ID="${OTHER}"</script>` }, (assets) => {
      expect(clientAppIdRefusal(assets, TARGET)?.message).toContain(OTHER)
    })
  })

  it('ignores non-code assets, which key nothing', () => {
    // A png whose bytes happen to spell an id is not what the browser runs.
    withClient({ 'logo.png': OTHER, 'notes.txt': OTHER }, (assets) => {
      expect(clientAppIdRefusal(assets, TARGET)).toBeNull()
    })
  })

  it('reports each foreign id once even when it is bundled into many chunks', () => {
    withClient(
      { 'a.js': `x="${OTHER}"`, 'b.js': `y="${OTHER}"`, 'c.js': `z="${TARGET}"` },
      (assets) => {
        const refusal = clientAppIdRefusal(assets, TARGET)?.message ?? ''
        expect(refusal.match(new RegExp(OTHER, 'g'))).toHaveLength(1)
      },
    )
  })

  /**
   * The half-migrated bundle. Verified against a real Vite 8 build of the
   * current src/constants.ts with no `define`: it succeeds with zero warnings
   * and emits `var e=__DEEPSPACE_APP_ID__`, which is a ReferenceError on the
   * first client module. No `app_…` literal survives that edit, so the
   * foreign-id scan above sees a clean bundle — this is the only thing between
   * that app and a silent total outage.
   */
  it('refuses a bundle whose app-id define was never substituted', () => {
    withClient({ 'index-a1b2.js': 'var e=__DEEPSPACE_APP_ID__,t=`app:${e}`;' }, (assets) => {
      const refusal = clientAppIdRefusal(assets, TARGET)
      expect(refusal?.code).toBe('app_id_define_unsubstituted')
      expect(refusal?.message).toContain('/index-a1b2.js')
      expect(refusal?.message).toContain('ReferenceError')
    })
  })

  it('ignores the documentation output subtree, whose samples only MENTION ids', () => {
    // Everything under _documentation/ is generated by the SDK's own docs
    // builder — compiled MDX chunks and prerendered per-page HTML alike —
    // and its code samples carry the define (and example ids) as string
    // content, not evaluated identifiers. Scanning it kept the deep.space
    // site itself from deploying. App-owned assets stay scanned.
    withClient(
      {
        '_documentation/assets/documentation-page-AWFCDME6.js': `const s="declare const __DEEPSPACE_APP_ID__: string";const x="${OTHER}"`,
        '_documentation/cli-reference/overview/index.html':
          '<td><code>__DEEPSPACE_APP_ID__</code></td>',
        // A root-mounted docs site writes the same output under
        // `_documentation-root/` — the plugin's ignore glob is `_documentation*`.
        '_documentation-root/assets/documentation-page-6EJXVFTR.js':
          'const s="__DEEPSPACE_APP_ID__"',
        'app.js': `const a="${TARGET}"`,
      },
      (assets) => {
        expect(clientAppIdRefusal(assets, TARGET)).toBeNull()
      },
    )
  })

  it('names every edit the migration needs, so half of it cannot be applied', () => {
    // Both refusals must enumerate the full adoption, or an app applies part of
    // it and ships a dead bundle. The steps are three files, no migration.
    for (const files of [
      { 'a.js': 'var e=__DEEPSPACE_APP_ID__' },
      { 'a.js': `var e="${OTHER}"` },
    ]) {
      withClient(files, (assets) => {
        const message = clientAppIdRefusal(assets, TARGET)?.message ?? ''
        expect(message).toContain('deepspace/build')
        expect(message).toContain('vite.config.ts')
        expect(message).toContain('vitest.config.ts')
        expect(message).toContain('src/constants.ts')
      })
    }
  })

  it('reports the dead bundle before a foreign id when a bundle has both', () => {
    withClient({ 'a.js': `var e=__DEEPSPACE_APP_ID__,f="${OTHER}"` }, (assets) => {
      expect(clientAppIdRefusal(assets, TARGET)?.code).toBe('app_id_define_unsubstituted')
    })
  })
})

/**
 * The push is the irreversible half of a deploy. Refusing an over-cap asset
 * from the local build means the cloud repo never advances onto a commit whose
 * release the platform was always going to reject.
 */
describe('oversizedAssetRefusal', () => {
  const asset = (path: string, size: number) => ({
    path,
    hash: 'x'.repeat(64),
    size,
    sourcePath: path,
  })

  it('passes a bundle whose every file is under the cap', () => {
    expect(oversizedAssetRefusal([asset('/a.js', 1024), asset('/b.png', 2048)])).toBeNull()
  })

  it('names the file, not its hash, and uses the same units as every other message', () => {
    const refusal = oversizedAssetRefusal([asset('/video.mp4', MAX_DEPLOY_ASSET_FILE_BYTES + 1)])
    expect(refusal).toContain('/video.mp4')
    expect(refusal).toContain('25.0 MiB')
    expect(refusal).not.toContain('x'.repeat(64))
    expect(refusal).toContain('deepspace app files put')
    // .gitignore does not keep a file out of the bundle; moving it does.
    expect(refusal).toContain('move it out of `public/`')
  })

  /**
   * The per-deploy total is env-configurable AND the server dedupes by content
   * hash before summing. A local total would be a guess at the limit doing
   * different arithmetic: these five entries are 120 MiB summed per path and
   * 24 MiB to the platform, which accepts them.
   */
  it('leaves the per-deploy total to the server, which alone knows it', () => {
    const same = Array.from({ length: 5 }, (_, i) =>
      asset(`/copy${i}.bin`, MAX_DEPLOY_ASSET_FILE_BYTES - 1),
    )
    expect(oversizedAssetRefusal(same)).toBeNull()
  })

  /** One constant, imported by both sides — not a mirrored number that drifts. */
  it('checks the same per-file cap the deploy worker enforces', () => {
    expect(MAX_DEPLOY_ASSET_FILE_BYTES).toBe(25 * 1024 * 1024)
  })
})

describe('uploadDeployAssets', () => {
  const SILENT_SPINNER = { start: vi.fn(), stop: vi.fn(), message: vi.fn() }

  function testOutput(): DeployOutput {
    return {
      json: true,
      nonInteractive: true,
      emitJson: vi.fn(),
      showIntro: vi.fn(),
      die(message, code): never {
        throw new Error(`${code}: ${message}`)
      },
    }
  }

  function buildAssets(files: Record<string, string>): {
    dir: string
    assets: ReturnType<typeof collectAssets>
  } {
    const dir = mkdtempSync(join(tmpdir(), 'deepspace-upload-'))
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    return { dir, assets: collectAssets(dir) }
  }

  const run = (
    assets: ReturnType<typeof collectAssets>,
    output = testOutput(),
    refreshToken?: () => Promise<string | null>,
  ) =>
    uploadDeployAssets({
      deployUrl: 'https://deploy.test',
      appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
      token: 'tok',
      refreshToken,
      assets,
      output,
      spinner: SILENT_SPINNER,
    })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('declares every unique hash and uploads only what the plan asks for', async () => {
    const { dir, assets } = buildAssets({
      'a.txt': 'alpha',
      'b.txt': 'beta',
      // Same content as a.txt: one hash on the wire, one upload.
      'c.txt': 'alpha',
    })
    try {
      const alpha = assets.find((asset) => asset.path === '/a.txt')!
      let planned: Array<{ hash: string; size: number }> = []
      const uploaded: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url).endsWith('/asset-plan')) {
            planned = (JSON.parse(String(init!.body)) as { assets: typeof planned }).assets
            return Response.json({ missing: [alpha.hash] })
          }
          uploaded.push(String(url).split('/').pop()!)
          expect(init!.method).toBe('PUT')
          expect(new Uint8Array(init!.body as Uint8Array)).toEqual(
            new Uint8Array(readFileSync(alpha.sourcePath)),
          )
          return Response.json({ ok: true })
        }),
      )

      await run(assets)
      expect(planned.map((entry) => entry.hash).sort()).toEqual(
        [...new Set(assets.map((asset) => asset.hash))].sort(),
      )
      expect(uploaded).toEqual([alpha.hash])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives replayable asset bodies a generous per-attempt timeout', async () => {
    const { dir, assets } = buildAssets({ 'slow.bin': 'body' })
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).endsWith('/asset-plan')
            ? Response.json({ missing: [assets[0].hash] })
            : Response.json({ ok: true }),
        ),
      )

      await run(assets)

      expect(timeoutSpy).toHaveBeenCalledWith(ASSET_UPLOAD_ATTEMPT_TIMEOUT_MS)
      expect(ASSET_UPLOAD_ATTEMPTS * ASSET_UPLOAD_ATTEMPT_TIMEOUT_MS).toBe(5 * 60_000)
    } finally {
      timeoutSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refreshes and retries when the asset plan rejects an expired bearer', async () => {
    const authorizations: string[] = []
    const refreshToken = vi.fn(async () => 'fresh-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('Authorization') ?? ''
        authorizations.push(authorization)
        return authorization === 'Bearer tok'
          ? Response.json({ error: 'Invalid or expired token' }, { status: 401 })
          : Response.json({ missing: [] })
      }),
    )

    await run([], testOutput(), refreshToken)

    expect(refreshToken).toHaveBeenCalledOnce()
    expect(authorizations).toEqual(['Bearer tok', 'Bearer fresh-token'])
  })

  it('preserves an auth-service outage while refreshing the asset plan bearer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'Invalid or expired token' }, { status: 401 })),
    )
    const authError = new ApiError('auth service unavailable', 503, 'auth_service_unavailable')

    await expect(
      run([], testOutput(), async () => {
        throw authError
      }),
    ).rejects.toThrow('auth_service_unavailable: auth service unavailable')
  })

  it('preserves an auth-service outage while refreshing an asset upload bearer', async () => {
    const { dir, assets } = buildAssets({ 'a.txt': 'alpha' })
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).endsWith('/asset-plan')
            ? Response.json({ missing: [assets[0].hash] })
            : Response.json({ error: 'Invalid or expired token' }, { status: 401 }),
        ),
      )
      const authError = new ApiError('auth service unavailable', 503, 'auth_service_unavailable')

      await expect(
        run(assets, testOutput(), async () => {
          throw authError
        }),
      ).rejects.toThrow('auth_service_unavailable: auth service unavailable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent expired upload responses into one token refresh', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 3 }, (_, index) => [`f${index}.txt`, `body-${index}`]),
    )
    const { dir, assets } = buildAssets(files)
    let releaseRefresh!: (token: string) => void
    const refreshToken = vi.fn(
      async () => await new Promise<string>((resolve) => (releaseRefresh = resolve)),
    )
    const expiredUploads: string[] = []
    const freshUploads: string[] = []
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url).endsWith('/asset-plan')) {
            return Response.json({ missing: assets.map((asset) => asset.hash) })
          }
          const hash = String(url).split('/').pop()!
          const authorization = new Headers(init?.headers).get('Authorization')
          if (authorization === 'Bearer tok') {
            expiredUploads.push(hash)
            return Response.json({ error: 'Invalid or expired token' }, { status: 401 })
          }
          freshUploads.push(hash)
          return Response.json({ ok: true })
        }),
      )

      const upload = run(assets, testOutput(), refreshToken)
      await vi.waitFor(() => expect(expiredUploads).toHaveLength(3))
      releaseRefresh('fresh-token')
      await upload

      expect(refreshToken).toHaveBeenCalledOnce()
      expect(expiredUploads.sort()).toEqual(assets.map((asset) => asset.hash).sort())
      expect(freshUploads.sort()).toEqual(assets.map((asset) => asset.hash).sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uploads every missing hash exactly once across the worker pool', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`f${index}.txt`, `body-${index}`]),
    )
    const { dir, assets } = buildAssets(files)
    try {
      const uploaded: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).endsWith('/asset-plan')) {
            return Response.json({ missing: assets.map((asset) => asset.hash) })
          }
          uploaded.push(String(url).split('/').pop()!)
          return Response.json({ ok: true })
        }),
      )

      await run(assets)
      expect(uploaded.sort()).toEqual(assets.map((asset) => asset.hash).sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /** The pool claims work by popping the queue, so a denominator computed from
   *  what's left climbs with the numerator (…, 10/10, 11/11) and never shows
   *  how much is actually left. */
  it('counts progress against the real total, not the shrinking queue', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`f${index}.txt`, `body-${index}`]),
    )
    const { dir, assets } = buildAssets(files)
    const spinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn() }
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).endsWith('/asset-plan')
            ? Response.json({ missing: assets.map((asset) => asset.hash) })
            : Response.json({ ok: true }),
        ),
      )
      await uploadDeployAssets({
        deployUrl: 'https://deploy.test',
        appId: 'app_01JQ',
        token: 'tok',
        assets,
        spinner,
        output: testOutput(),
      })
      const progress = spinner.message.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith('Uploading assets'))
      expect(progress).toHaveLength(11)
      expect(progress.every((line) => line.includes('/11'))).toBe(true)
      expect(progress.at(-1)).toContain('11/11')
      expect(progress.at(0)).toContain('1/11')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces the platform’s own refusal instead of a generic upload failure', async () => {
    const { dir, assets } = buildAssets({ 'a.txt': 'alpha' })
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          String(url).endsWith('/asset-plan')
            ? Response.json({ missing: [assets[0].hash] })
            : Response.json(
                { error: 'Asset content hash mismatch', code: 'hash_mismatch' },
                { status: 400 },
              ),
        ),
      )
      await expect(run(assets)).rejects.toThrow(/hash_mismatch: Asset content hash mismatch/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a plan naming content this build does not have', async () => {
    const { dir, assets } = buildAssets({ 'a.txt': 'alpha' })
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ missing: ['f'.repeat(64)] })),
      )
      await expect(run(assets)).rejects.toThrow(/not part of this build/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a refused plan with the platform’s message and code', async () => {
    const { dir, assets } = buildAssets({ 'a.txt': 'alpha' })
    const refreshToken = vi.fn(async () => 'must-not-be-used')
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(
            { error: 'This deploy’s assets total too much', code: 'assets_too_large' },
            { status: 413 },
          ),
        ),
      )
      await expect(run(assets, testOutput(), refreshToken)).rejects.toThrow(
        /assets_too_large: This deploy’s assets total/,
      )
      expect(refreshToken).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('moves no bytes for a deploy with no assets at all', async () => {
    const fetchStub = vi.fn(async () => Response.json({ missing: [] }))
    vi.stubGlobal('fetch', fetchStub)
    await run([])
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ assets: [] })
  })
})

describe('deploy failure reporting', () => {
  const HTML_1101 =
    '<!DOCTYPE html><html><body>Error 1101 Ray ID: abc — Worker threw exception</body></html>'

  it('names a deploy-service resource limit instead of blaming Cloudflare', () => {
    expect(isDeployServiceResourceLimit(500, HTML_1101)).toBe(true)
    const message = formatDeployWorkerError(500, HTML_1101)
    expect(message).toMatch(/DeepSpace deploy service hit a resource limit/)
    expect(message).not.toMatch(/Cloudflare Dashboard\/API/)
  })

  it('classifies an exceeded-resources 1102 the same way', () => {
    const body = 'Error 1102 Ray ID: def — Worker exceeded resource limits'
    expect(isDeployServiceResourceLimit(500, body)).toBe(true)
    expect(formatDeployWorkerError(500, body)).toMatch(/DeepSpace deploy service/)
  })

  it('still reports a relayed Cloudflare control-plane error as a Cloudflare incident', () => {
    const message = formatDeployWorkerError(500, 'Worker deploy failed (500): upstream broke')
    expect(message).toMatch(/Cloudflare Dashboard\/API/)
    expect(message).not.toMatch(/DeepSpace deploy service hit a resource limit/)
  })

  it('prints a deterministic upload rejection verbatim instead of the incident hint', () => {
    // The exact misdiagnosis from AX S1: a permanent input error prescribed
    // an infinite "wait for Cloudflare to recover and retry" loop.
    const rejection =
      "Cloudflare rejected the worker upload: Binding name 'X…' (length 5000) exceeds the limit of 2712."
    const message = formatDeployWorkerError(409, rejection, 'worker_upload_rejected')
    expect(message).toBe(rejection)
  })

  it('passes the new rejection shape through even without its code (defense in depth)', () => {
    // The server sends code worker_upload_rejected with this message shape;
    // even code-less, the sentence must reach the user verbatim (409 < 500
    // and no incident needle matches).
    const message = formatDeployWorkerError(
      409,
      "Cloudflare rejected the worker upload: Binding name 'X' exceeds the limit of 2712.",
    )
    expect(message).toMatch(/exceeds the limit of 2712/)
    expect(message).not.toMatch(/Cloudflare Dashboard\/API/)
  })

  it('does not mistake an app id or byte count containing 1101 for a limit failure', () => {
    expect(isDeployServiceResourceLimit(409, 'assets total 11012 bytes')).toBe(false)
  })

  it('prints the platform’s CLI-update instruction verbatim', () => {
    const instruction =
      'Your deepspace CLI is out of date — run `npx deepspace@latest app update`, follow the upgrade steps, then deploy again.'
    expect(formatDeployWorkerError(410, instruction, 'cli_outdated')).toBe(instruction)
  })

  it('passes a plain client-side refusal through unchanged', () => {
    expect(formatDeployWorkerError(409, 'App is suspended')).toBe('App is suspended')
  })
})

describe('postWithRetry', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const URL = 'https://deploy.test/api'
  const makeInit = () => ({ method: 'POST', body: 'x' }) as RequestInit

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('returns a 2xx immediately without retrying', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))
    const res = await postWithRetry(URL, makeInit)
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns a client 4xx as-is without retrying (caller surfaces it)', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 413 }))
    const res = await postWithRetry(URL, makeInit)
    expect(res.status).toBe(413)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bounds every attempt: a hung request aborts at timeoutMs and the retry succeeds', async () => {
    // The mock hangs forever but honors the abort signal — exactly what a
    // stalled deploy service looks like to undici.
    fetchMock
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await postWithRetry(URL, makeInit, { timeoutMs: 25 })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Every attempt carries a bound — no unbounded fetch leaves this helper.
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('retries a thrown fetch (the EPIPE case) and rebuilds the body each attempt', async () => {
    vi.useFakeTimers()
    const initSpy = vi.fn(() => ({ method: 'POST', body: 'x' }) as RequestInit)
    fetchMock
      .mockRejectedValueOnce(new Error('write EPIPE'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const promise = postWithRetry(URL, initSpy)
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(initSpy).toHaveBeenCalledTimes(2) // fresh body per attempt
  })

  it('retries a transient 5xx when retryServerErrors is on (default)', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const promise = postWithRetry(URL, makeInit)
    await vi.runAllTimersAsync()
    const res = await promise

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 5xx when retryServerErrors is off (commit double-deploy guard)', async () => {
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }))
    const res = await postWithRetry(URL, makeInit, { retryServerErrors: false })
    expect(res.status).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws after exhausting its attempts on a persistent network error', async () => {
    vi.useFakeTimers()
    fetchMock.mockRejectedValue(new Error('write EPIPE'))

    const promise = postWithRetry(URL, makeInit, { attempts: 3 })
    const rejection = expect(promise).rejects.toThrow('write EPIPE')
    await vi.runAllTimersAsync()
    await rejection
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('pushWithTransientRetry (deploy auto-push)', () => {
  const committed: PushRefResult = {
    status: 'committed',
    localRef: 'refs/heads/main',
    remoteRef: 'refs/heads/main',
    summary: 'abc1234..def5678',
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries an HTTP 429 throw with backoff and returns the eventual result', async () => {
    vi.useFakeTimers()
    const doPush = vi
      .fn<() => PushRefResult>()
      .mockImplementationOnce(() => {
        throw new Error(
          "fatal: unable to access 'https://x/': The requested URL returned error: 429",
        )
      })
      .mockReturnValueOnce(committed)

    const promise = pushWithTransientRetry(doPush)
    await vi.runAllTimersAsync()
    expect(await promise).toBe(committed)
    expect(doPush).toHaveBeenCalledTimes(2)
  })

  it("retries an HTTP 503 throw (the repo store's brief compaction freeze)", async () => {
    vi.useFakeTimers()
    const doPush = vi
      .fn<() => PushRefResult>()
      .mockImplementationOnce(() => {
        throw new Error('error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503')
      })
      .mockReturnValueOnce(committed)

    const promise = pushWithTransientRetry(doPush)
    await vi.runAllTimersAsync()
    expect(await promise).toBe(committed)
    expect(doPush).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a non-transient failure (surfaces it on the first throw)', async () => {
    const doPush = vi.fn<() => PushRefResult>().mockImplementation(() => {
      throw new Error("fatal: unable to access 'https://x/': The requested URL returned error: 401")
    })
    await expect(pushWithTransientRetry(doPush)).rejects.toThrow('401')
    expect(doPush).toHaveBeenCalledTimes(1)
  })

  it('gives up after the backoff schedule and rethrows the transient error', async () => {
    vi.useFakeTimers()
    const doPush = vi.fn<() => PushRefResult>().mockImplementation(() => {
      throw new Error('The requested URL returned error: 503')
    })
    const promise = pushWithTransientRetry(doPush)
    const rejection = expect(promise).rejects.toThrow('503')
    await vi.runAllTimersAsync()
    await rejection
    expect(doPush).toHaveBeenCalledTimes(4) // 1 try + 3 backoffs
  })

  it('stops retrying once the wall-clock budget is spent, however few attempts ran', async () => {
    vi.useFakeTimers()
    // Each attempt re-uploads the whole pack. A bounded ATTEMPT count is not a
    // bounded WAIT: one slow attempt can outlast the budget on its own, and
    // deploy must still fail fast rather than sit silently.
    const doPush = vi.fn<() => PushRefResult>().mockImplementation(() => {
      vi.advanceTimersByTime(90_000)
      throw new Error('The requested URL returned error: 503')
    })
    const promise = pushWithTransientRetry(doPush)
    const rejection = expect(promise).rejects.toThrow('503')
    await vi.runAllTimersAsync()
    await rejection
    // Two attempts fit inside the 120s budget; the third would start past it.
    expect(doPush).toHaveBeenCalledTimes(2)
  })
})

describe('deployRepositoryFailure (auto-push error contract)', () => {
  it('preserves a first-registration app quota refusal distinctly', () => {
    const failure = deployRepositoryFailure(
      new GitError("fatal: unable to access 'https://x/': The requested URL returned error: 409"),
    )

    expect(failure.code).toBe('app_quota_exceeded')
    expect(failure.error).toContain('active-app quota')
    expect(failure.error).toContain('deepspace app list')
    expect(failure).not.toHaveProperty('action')
  })

  it('preserves transient rate limiting without conflating app quota', () => {
    const failure = deployRepositoryFailure(
      new GitError("fatal: unable to access 'https://x/': The requested URL returned error: 429"),
    )

    expect(failure.code).toBe('rate_limited')
    expect(failure.error).toContain('Wait a few seconds')
    expect(failure.error).not.toContain('app quota')
    expect(failure).not.toHaveProperty('action')
  })

  it('preserves an explicit GitError code and message without wrapping it', () => {
    expect(
      deployRepositoryFailure(
        new GitError(
          'git is not installed or not on PATH — install git and retry.',
          'git_not_installed',
        ),
      ),
    ).toEqual({
      code: 'git_not_installed',
      error: 'git is not installed or not on PATH — install git and retry.',
    })
  })

  it('does not misclassify an unrelated 429 count as an HTTP failure', () => {
    expect(deployRepositoryFailure(new GitError('Total 429 (delta 3)'))).toEqual({
      code: 'git_error',
      error: 'Version-control sync failed: Total 429 (delta 3)',
    })
  })

  it('keeps the generic boundary for an untyped failure', () => {
    expect(deployRepositoryFailure(new Error('unexpected local failure'))).toEqual({
      code: 'vc_sync_failed',
      error: 'Version-control sync failed: unexpected local failure',
    })
  })
})

describe('staleBaseGuardFields (deploy --json passthrough)', () => {
  it("passes through the server's skipped marker", () => {
    expect(staleBaseGuardFields({ staleBaseGuard: 'skipped' })).toEqual({
      staleBaseGuard: 'skipped',
    })
  })

  it('is empty for normal/older servers — absent field or unknown values', () => {
    expect(staleBaseGuardFields({})).toEqual({})
    expect(staleBaseGuardFields({ staleBaseGuard: 'ran' })).toEqual({})
    expect(staleBaseGuardFields({ staleBaseGuard: true })).toEqual({})
  })
})

describe('shouldSendLineage (deploy release-lineage gate)', () => {
  const oid = 'a'.repeat(40)

  it('records lineage only when a commit was actually synced this deploy (recoverable)', () => {
    expect(shouldSendLineage(oid, true)).toBe(true)
  })

  it('withholds lineage for a resolved-but-unsynced commit (skipped/rejected/--no-push)', () => {
    // The B6 case: a skipped .dev.vars push or a server-rejected oversized object
    // still resolves a commitOid, but sending it would 409 every later deploy.
    expect(shouldSendLineage(oid, false)).toBe(false)
  })

  it('withholds lineage when there is no commit at all', () => {
    expect(shouldSendLineage(null, true)).toBe(false)
    expect(shouldSendLineage(null, false)).toBe(false)
  })
})

describe('workspace deploy lineage', () => {
  const oid = 'a'.repeat(40)

  it('is recoverable only when an active workspace published this exact HEAD', () => {
    expect(workspaceDeployLineage('active', oid, oid)).toBe('recoverable')
    expect(workspaceDeployLineage('active', 'b'.repeat(40), oid)).toBe('unsynced')
    expect(workspaceDeployLineage('active', null, oid)).toBe('unsynced')
    expect(workspaceDeployLineage('landed', oid, oid)).toBe('inactive')
  })
})

describe('dirtyWorktreeRefusal (DeepSpace source deploy is commit-first)', () => {
  it('refuses with the stable code and names BOTH escapes (commit, or --no-push)', () => {
    const r = dirtyWorktreeRefusal('main')
    expect(r.code).toBe('dirty_worktree')
    expect(r.error).toContain('uncommitted changes')
    expect(r.error).toContain('--no-push')
  })

  it('on a ws/<id> branch, points at THAT branch', () => {
    const branch = 'ws/01hq9j8k7m6n5p4r3s2t1v0w9x'
    const r = dirtyWorktreeRefusal(branch)
    expect(r.error).toContain(branch)
    expect(r.error).toContain('WIP commits are fine')
  })

  it('off a workspace branch, suggests creating one for work in progress', () => {
    expect(dirtyWorktreeRefusal('main').error).toContain('deepspace workspace new')
    expect(dirtyWorktreeRefusal(null).error).toContain('deepspace workspace new')
  })
})

describe('preflightDeployRepository', () => {
  it('detects a dirty DeepSpace-source checkout before build work begins', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-deploy-preflight-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
      writeFileSync(join(repo, 'app.txt'), 'committed\n')
      execFileSync('git', ['add', 'app.txt'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'source'], { cwd: repo })
      writeFileSync(join(repo, 'app.txt'), 'dirty\n')

      expect(
        preflightDeployRepository({
          appDir: repo,
          push: true,
          source: { provider: 'deepspace' },
        }),
      ).toMatchObject({ code: 'dirty_worktree' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('refuses merge_in_progress (not dirty_worktree) inside an unresolved merge — the same guard push/pull use', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-deploy-preflight-'))
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
    try {
      run(['init', '-q', '-b', 'main'])
      run(['config', 'user.email', 'test@example.com'])
      run(['config', 'user.name', 'Test'])
      writeFileSync(join(repo, 'C.md'), 'base\n')
      run(['add', '-A'])
      run(['commit', '-q', '-m', 'base'])
      run(['switch', '-q', '-c', 'sideA'])
      writeFileSync(join(repo, 'C.md'), 'A\n')
      run(['commit', '-q', '-am', 'A'])
      run(['switch', '-q', 'main'])
      writeFileSync(join(repo, 'C.md'), 'B\n')
      run(['commit', '-q', '-am', 'B'])
      expect(() => run(['merge', 'sideA'])).toThrow()

      expect(
        preflightDeployRepository({ appDir: repo, push: true, source: { provider: 'deepspace' } }),
      ).toMatchObject({ code: 'merge_in_progress' })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not impose commit-first rules on GitHub source or --no-push', () => {
    const missingRepo = join(tmpdir(), 'not-a-repository')
    expect(
      preflightDeployRepository({
        appDir: missingRepo,
        push: true,
        source: { provider: 'github', repository: 'deepdotspace/example' },
      }),
    ).toBeNull()
    expect(preflightDeployRepository({ appDir: missingRepo, push: false, source: null })).toBeNull()
  })
})

describe('manual GitHub deploy', () => {
  it('deploys a dirty GitHub working tree without GitHub verification or release lineage', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-deploy-no-push-github-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
      writeFileSync(join(repo, 'app.txt'), 'committed\n')
      execFileSync('git', ['add', 'app.txt'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'source'], { cwd: repo })
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        encoding: 'utf-8',
      }).trim()
      writeFileSync(join(repo, 'app.txt'), 'local manual deploy\n')

      const output: DeployOutput = {
        json: true,
        nonInteractive: true,
        emitJson: vi.fn(),
        showIntro: vi.fn(),
        die(message, code): never {
          throw new Error(`${code}: ${message}`)
        },
      }
      const result = await syncDeployRepository({
        deployUrl: 'https://deploy.test',
        appDir: repo,
        appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
        token: 'test-token',
        push: true,
        ignoreStale: false,
        output,
        sourceState: {
          appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
          source: { provider: 'github', repository: 'deepdotspace/example' },
          revision: 3,
          registered: true,
        },
      })

      expect(result).toMatchObject({
        commitOid: null,
        recoverable: false,
        source: { provider: 'github', repository: 'deepdotspace/example' },
        sourceRevision: 3,
        // With no commit recorded, these two ARE the record of what shipped.
        branch: 'main',
        dirty: true,
      })
      expect(shouldSendLineage(result.commitOid, result.recoverable)).toBe(false)
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim(),
      ).toBe(head)
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' })).toBe(
        ' M app.txt\n',
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('warns on the human stream that an uncommitted tree is going live untraceably', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-deploy-github-dirty-'))
    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(p.log, 'info').mockImplementation(() => {})
    try {
      execFileSync('git', ['init', '-q', '-b', 'feature/probe'], { cwd: repo })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
      writeFileSync(join(repo, 'app.txt'), 'committed\n')
      execFileSync('git', ['add', 'app.txt'], { cwd: repo })
      execFileSync('git', ['commit', '-q', '-m', 'source'], { cwd: repo })
      writeFileSync(join(repo, 'app.txt'), 'uncommitted\n')

      const githubDeploy = (): Promise<unknown> =>
        syncDeployRepository({
          deployUrl: 'https://deploy.test',
          appDir: repo,
          appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
          token: 'test-token',
          push: true,
          ignoreStale: false,
          output: {
            json: true,
            nonInteractive: true,
            emitJson: vi.fn(),
            showIntro: vi.fn(),
            die(message, code): never {
              throw new Error(`${code}: ${message}`)
            },
          },
          sourceState: {
            appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
            source: { provider: 'github', repository: 'deepdotspace/example' },
            revision: 1,
            registered: true,
          },
        })

      await githubDeploy()
      const dirtyWarning = warn.mock.calls.map((call) => String(call[0])).join('\n')
      expect(dirtyWarning).toContain('feature/probe')
      expect(dirtyWarning).toContain('uncommitted changes')

      // Clean tree: still says which branch shipped — the release records no
      // commit either way — but nothing to warn about.
      execFileSync('git', ['checkout', '-q', '--', 'app.txt'], { cwd: repo })
      warn.mockClear()
      const clean = (await githubDeploy()) as { branch: string; dirty: boolean }
      expect(clean).toMatchObject({ branch: 'feature/probe', dirty: false })
      expect(warn).not.toHaveBeenCalled()
      expect(info.mock.calls.map((call) => String(call[0])).join('\n')).toContain('feature/probe')
    } finally {
      vi.restoreAllMocks()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('detachedHeadRefusal', () => {
  it('requires a branch unless the caller explicitly opts out of source sync', () => {
    const refusal = detachedHeadRefusal()
    expect(refusal.code).toBe('detached_head')
    expect(refusal.error).toContain('detached')
    expect(refusal.error).toContain('branch')
    expect(refusal.error).toContain('--no-push')
  })
})

/**
 * The machine contract promises a stable `code` on every refusal, and a
 * Cloudflare control-plane failure reaches the CLI as prose with none. This
 * is the commonest failure an agent meets on this verb, so the phase name is
 * the floor rather than an absent key.
 */
describe('deployBuiltBundle codes a codeless server failure', () => {
  const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('falls back to deploy_failed when the server sends no code of its own', async () => {
    // The json-mode output captures process.stdout.write at CONSTRUCTION and
    // emits the envelope through that captured reference, so the spy has to
    // be installed before createDeployOutput runs.
    const lines: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk))
      return true
    }) as never)
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // URL-aware: the capabilities preflight (`/api/health`) must succeed so
    // the run reaches the commit POST, which is the refusal under test.
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/health')) {
        return new Response(
          JSON.stringify({ capabilities: { assetTransport: 'content-addressed-v1' } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      if (url.includes('/asset-plan')) {
        return new Response(JSON.stringify({ missing: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // The commit POST: the ordinary "server refused, and said nothing
      // machine-readable" — the refusal under test.
      return new Response(JSON.stringify({ success: false, error: 'Cloudflare said no' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }) as never)

    const output = createDeployOutput(true)
    const spinner = { start: () => {}, stop: () => {}, message: () => {} }
    const bundle = {
      worker: {
        main: 'index.js',
        modules: [{ name: 'index.js', content: 'export default {}' }],
      },
      assets: [],
      appMigrations: [],
      doManifest: undefined,
      customBindings: [],
      extraRoutes: [],
      assetConfig: {},
      compatibilityDate: '',
      compatibilityFlags: [],
      notFoundHandling: '',
    }

    await expect(
      deployBuiltBundle({
        deployUrl: 'https://deploy.test',
        appDir: '/tmp/none',
        appId: APP_ID,
        appName: 'example',
        token: 'token',
        rename: false,
        claimReleased: false,
        ignoreStale: false,
        bundle: bundle as never,
        secretsConfig: 'prd',
        envName: undefined,
        repository: { commitOid: null, recoverable: false } as never,
        output,
        spinner: spinner as never,
      }),
    ).rejects.toThrow()
    stdoutSpy.mockRestore()

    const envelope = JSON.parse(
      lines
        .join('')
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .at(-1) as string,
    ) as Record<string, unknown>
    expect(envelope).toMatchObject({ ok: false, code: 'deploy_failed' })
    expect(String(envelope.error)).toContain('Cloudflare said no')
  })
})

describe("forbiddenDeployMessage (deploy `forbidden` = another account's app)", () => {
  const token = (payload: object) =>
    `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`

  it('names the signed-in account and the app, and the two recoveries', () => {
    const msg = forbiddenDeployMessage(
      'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
      token({ email: 'me@x.test' }),
    )
    expect(msg).toContain('app_01ABCDEFGHJKMNPQRSTVWXYZ00 belongs to another account')
    expect(msg).toContain('signed in as me@x.test')
    expect(msg).toContain('deepspace app collaborators add me@x.test')
    expect(msg).toContain('deepspace app init --new-id')
  })

  it('degrades to the user id, then to a generic account, without throwing', () => {
    expect(forbiddenDeployMessage('app_x', token({ sub: 'user_1' }))).toContain(
      'signed in as user_1',
    )
    expect(forbiddenDeployMessage('app_x', 'garbage')).toContain('signed in as this account')
  })
})

describe('deploy lock (one deploy per checkout)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ds-deploy-lock-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('takes, then releases, the lock; a second run while held refuses deploy_in_progress naming the holder', () => {
    const release = acquireDeployLock(dir)
    const record = JSON.parse(readFileSync(deployLockPath(dir), 'utf-8')) as {
      pid: number
      startedAt: string
      token: string
    }
    expect(record.pid).toBe(process.pid)
    expect(record.token).toEqual(expect.any(String))
    let thrown: unknown
    try {
      acquireDeployLock(dir)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toMatchObject({
      code: 'deploy_in_progress',
      extra: { lockPath: deployLockPath(dir), holder: { pid: process.pid } },
    })
    expect((thrown as Error).message).toContain(`pid ${process.pid}`)
    expect((thrown as Error).message).toContain(record.startedAt)
    release()
    expect(() => readFileSync(deployLockPath(dir))).toThrow()
  })

  it('reclaims a lock whose holder pid is provably dead instead of stalling', () => {
    // AX C1 (docs/audits/2026-09-01): a SIGINT-killed deploy orphaned the
    // lock and the refusal prescribed a ten-minute wait for a dead holder.
    mkdirSync(join(dir, '.deepspace'), { recursive: true })
    const orphaned = { pid: 2 ** 22 + 1, startedAt: 'yesterday', token: 'stale-token' }
    writeFileSync(deployLockPath(dir), JSON.stringify(orphaned))

    const release = acquireDeployLock(dir)
    const record = JSON.parse(readFileSync(deployLockPath(dir), 'utf-8')) as { pid: number }
    expect(record.pid).toBe(process.pid)
    release()
  })

  it('reclaims an outlived lock file by mtime even when its pid reads alive', () => {
    // Zombie pids answer kill-0 as alive forever (v0.27.0 r1 AX BUG-2); the
    // file's age is the zombie-proof staleness signal.
    mkdirSync(join(dir, '.deepspace'), { recursive: true })
    const zombie = { pid: process.pid, startedAt: 'yesterday', token: 'zombie-token' }
    writeFileSync(deployLockPath(dir), JSON.stringify(zombie))
    const old = new Date(Date.now() - 11 * 60_000)
    utimesSync(deployLockPath(dir), old, old)

    const release = acquireDeployLock(dir)
    expect(
      (JSON.parse(readFileSync(deployLockPath(dir), 'utf-8')) as { token: string }).token,
    ).not.toBe('zombie-token')
    release()
  })

  it('releases the lock and exits through process.exit on SIGINT', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit called')
    }) as never)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      acquireDeployLock(dir)
      expect(() => process.emit('SIGINT' as never)).toThrow('exit called')
      expect(exitSpy).toHaveBeenCalledWith(130)
      expect(() => readFileSync(deployLockPath(dir))).toThrow()
      expect(String(stderrSpy.mock.calls.at(-1)?.[0])).toContain('released the deploy lock')
    } finally {
      exitSpy.mockRestore()
      stderrSpy.mockRestore()
    }
  })

  it('an old release callback cannot delete a replacement holder', () => {
    const releaseOld = acquireDeployLock(dir)
    rmSync(deployLockPath(dir))
    const releaseCurrent = acquireDeployLock(dir)
    const current = readFileSync(deployLockPath(dir), 'utf-8')

    releaseOld()
    expect(readFileSync(deployLockPath(dir), 'utf-8')).toBe(current)

    releaseCurrent()
    expect(() => readFileSync(deployLockPath(dir))).toThrow()
  })

  it('refuses a fresh unreadable lock file rather than guessing it stale', () => {
    // A young unreadable file may be a concurrent writer mid-create; only
    // age can prove it abandoned.
    mkdirSync(join(dir, '.deepspace'), { recursive: true })
    writeFileSync(deployLockPath(dir), 'not json')
    let thrown: unknown
    try {
      acquireDeployLock(dir)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toMatchObject({ code: 'deploy_in_progress' })
    expect((thrown as Error).message).toContain('unreadable')
    expect(readFileSync(deployLockPath(dir), 'utf-8')).toBe('not json')
  })
})

describe('shippedSourceEvidence — the deploy envelope names what authority shipped', () => {
  it('claimed GitHub, claimed DeepSpace, inferred evidence, and no evidence', () => {
    expect(
      shippedSourceEvidence({
        source: { provider: 'github', repository: 'acme/x' },
        observedRepository: null,
      }),
    ).toEqual({ provider: 'github', repository: 'acme/x' })
    expect(
      shippedSourceEvidence({ source: { provider: 'deepspace' }, observedRepository: null }),
    ).toEqual({ provider: 'deepspace' })
    // Unclaimed with observed evidence: same request shape, marked inferred
    // because the server has not committed the first-release latch yet.
    expect(shippedSourceEvidence({ source: null, observedRepository: 'acme/y' })).toEqual({
      provider: 'github',
      repository: 'acme/y',
      inferred: true,
    })
    expect(shippedSourceEvidence({ source: null, observedRepository: null })).toBeNull()
  })
})
