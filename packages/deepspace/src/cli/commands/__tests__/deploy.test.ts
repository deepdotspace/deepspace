/**
 * CLI-side coverage for the chunked-deploy resilience logic. The worker tests
 * (platform/deploy-worker) cover the receiving end; these cover the part that
 * actually survives a flaky uplink — the asset packing and the retry gate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { packAssetGroups, postWithRetry, classifyDevVarsSecrets } from '../deploy'

type Asset = { path: string; contentBase64: string }

/** An asset whose serialized JSON is at least `bytes` long (content padded). */
function assetOfSize(path: string, bytes: number): Asset {
  const overhead = JSON.stringify({ path, contentBase64: '' }).length
  return { path, contentBase64: 'A'.repeat(Math.max(0, bytes - overhead)) }
}

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
