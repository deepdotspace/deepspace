/** Deploy CLI decision and request helpers, imported from their owning modules. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { blankSelectorRefusal, staleBaseGuardFields } from '../deploy'
import {
  collectAssets,
  extractRunWorkerFirst,
  isDeployAssetControlFile,
  readDeployAssetConfig,
  resolveDeployRunWorkerFirst,
} from '../deploy/build'
import {
  assetManifest,
  formatDeployWorkerError,
  isDeployServiceResourceLimit,
  postWithRetry,
  uploadDeployAssets,
} from '../deploy/request'
import { classifyDevVarsSecrets } from '../deploy/secrets'
import {
  deployRepositoryFailure,
  dirtyWorktreeRefusal,
  detachedHeadRefusal,
  pushWithTransientRetry,
  shouldSendLineage,
  syncDeployRepository,
  workspaceDeployLineage,
} from '../deploy/repository'
import type { DeployOutput } from '../deploy/output'
import type { PushRefResult } from '../../lib/vc-push'
import { GitError } from '../../lib/git/process'

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

  const run = (assets: ReturnType<typeof collectAssets>, output = testOutput()) =>
    uploadDeployAssets({
      deployUrl: 'https://deploy.test',
      appId: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
      token: 'tok',
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
      await expect(run(assets)).rejects.toThrow(/assets_too_large: This deploy’s assets total/)
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

  it('does not mistake an app id or byte count containing 1101 for a limit failure', () => {
    expect(isDeployServiceResourceLimit(409, 'assets total 11012 bytes')).toBe(false)
  })

  it('prints the platform’s CLI-update instruction verbatim', () => {
    const instruction = 'Your deepspace CLI is out of date — update to deploy.'
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

describe('classifyDevVarsSecrets (#145 secret-drop guard)', () => {
  it('BLOCKS when the store is empty but .dev.vars has hand-edited secrets', () => {
    // The dangerous case: deploying would ship no secrets and drop any live ones.
    const r = classifyDevVarsSecrets({
      storeSecretNames: [],
      handEditedDevVarKeys: ['API_KEY', 'DB_URL'],
      allowMissing: false,
    })
    expect(r.kind).toBe('block')
    expect(r.kind === 'block' && r.strayKeys).toEqual(['API_KEY', 'DB_URL'])
  })

  it('does NOT block when --allow-missing-secrets is set (warns instead)', () => {
    const r = classifyDevVarsSecrets({
      storeSecretNames: [],
      handEditedDevVarKeys: ['API_KEY'],
      allowMissing: true,
    })
    expect(r.kind).toBe('warn')
  })

  it('only WARNS when the store already ships secrets and .dev.vars has extras', () => {
    const r = classifyDevVarsSecrets({
      storeSecretNames: ['API_KEY'],
      handEditedDevVarKeys: ['API_KEY', 'LOCAL_ONLY'],
      allowMissing: false,
    })
    expect(r.kind).toBe('warn')
    expect(r.kind === 'warn' && r.strayKeys).toEqual(['LOCAL_ONLY'])
  })

  it('is ok when every hand-edited .dev.vars key is already in the store', () => {
    const r = classifyDevVarsSecrets({
      storeSecretNames: ['API_KEY', 'DB_URL'],
      handEditedDevVarKeys: ['API_KEY'],
      allowMissing: false,
    })
    expect(r.kind).toBe('ok')
  })

  it('is ok when there are no hand-edited .dev.vars secrets (empty store, empty file)', () => {
    const r = classifyDevVarsSecrets({
      storeSecretNames: [],
      handEditedDevVarKeys: [],
      allowMissing: false,
    })
    expect(r.kind).toBe('ok')
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
        baseReleaseId: null,
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
