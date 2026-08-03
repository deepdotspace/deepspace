/** Deploy CLI decision and request helpers, imported from their owning modules. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { blankSelectorRefusal, staleBaseGuardFields } from '../deploy'
import { packAssetGroups, postWithRetry } from '../deploy/request'
import { classifyDevVarsSecrets } from '../deploy/secrets'
import {
  deployRepositoryFailure,
  dirtyWorktreeRefusal,
  detachedHeadRefusal,
  pushWithTransientRetry,
  shouldSendLineage,
  workspaceDeployLineage,
} from '../deploy/repository'
import type { PushRefResult } from '../../lib/vc-push'
import { GitError } from '../../lib/git/process'

type Asset = { path: string; contentBase64: string }

/** An asset whose serialized JSON is at least `bytes` long (content padded). */
function assetOfSize(path: string, bytes: number): Asset {
  const overhead = JSON.stringify({ path, contentBase64: '' }).length
  return { path, contentBase64: 'A'.repeat(Math.max(0, bytes - overhead)) }
}

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

describe('packAssetGroups', () => {
  it('returns no groups for an empty asset list', () => {
    expect(packAssetGroups([], 1000)).toEqual([])
  })

  it('keeps a single small asset in one group', () => {
    const assets: Asset[] = [{ path: '/a', contentBase64: 'aGk=' }]
    expect(packAssetGroups(assets, 1000)).toEqual([assets])
  })

  it('packs multiple small assets that fit under the cap into one group', () => {
    const assets: Asset[] = [
      { path: '/a', contentBase64: 'aA==' },
      { path: '/b', contentBase64: 'bA==' },
      { path: '/c', contentBase64: 'cA==' },
    ]
    const groups = packAssetGroups(assets, 1000)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toEqual(assets)
  })

  it('splits into multiple groups, losing or reordering nothing', () => {
    // ~100B each, 60B cap forces one asset per group.
    const assets = Array.from({ length: 6 }, (_, i) => assetOfSize(`/file-${i}`, 100))
    const groups = packAssetGroups(assets, 60)
    expect(groups.length).toBeGreaterThan(1)
    // Flattening the groups in order reproduces the input exactly.
    expect(groups.flat()).toEqual(assets)
  })

  it('never lets a multi-asset group exceed the cap', () => {
    const assets = Array.from({ length: 20 }, (_, i) => assetOfSize(`/file-${i}`, 50))
    const cap = 200
    const groups = packAssetGroups(assets, cap)
    for (const group of groups) {
      // The whole point of the cap: a group with >1 asset must serialize under it.
      // (A lone asset bigger than the cap is the documented exception below.)
      if (group.length > 1) {
        expect(Buffer.byteLength(JSON.stringify(group), 'utf-8')).toBeLessThanOrEqual(cap)
      }
    }
    expect(groups.flat()).toEqual(assets)
  })

  it('never splits a single oversized asset — it gets its own group', () => {
    const big = assetOfSize('/huge', 500)
    const assets: Asset[] = [
      { path: '/small-1', contentBase64: 'AA==' },
      big,
      { path: '/small-2', contentBase64: 'BB==' },
    ]
    const groups = packAssetGroups(assets, 100)
    // The oversized asset is alone in its own group (not split, not merged).
    const bigGroup = groups.find((g) => g.includes(big))
    expect(bigGroup).toEqual([big])
    expect(groups.flat()).toEqual(assets)
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

describe('dirtyWorktreeRefusal (deploy is commit-first)', () => {
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

describe('detachedHeadRefusal', () => {
  it('requires a branch unless the caller explicitly opts out of source sync', () => {
    const refusal = detachedHeadRefusal()
    expect(refusal.code).toBe('detached_head')
    expect(refusal.error).toContain('detached')
    expect(refusal.error).toContain('branch')
    expect(refusal.error).toContain('--no-push')
  })
})
