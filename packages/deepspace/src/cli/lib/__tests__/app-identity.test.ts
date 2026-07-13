import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOwnedAppId } from '../app-identity'

function mockApps(apps: Array<{ appId: string; name: string | null }>, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => ({ apps }) }) as unknown as Response),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('resolveOwnedAppId — adopt an existing app id instead of minting', () => {
  it('adopts the caller’s app id for a matching subdomain (the cutover case)', async () => {
    mockApps([
      { appId: 'app_0000000000000000000000OTHER', name: 'otherapp' },
      { appId: 'app_01KX8ZYZQ88VRTJZFAWPGNCCSX', name: 'videostudio' },
    ])
    expect(await resolveOwnedAppId('https://d', 't', 'videostudio')).toBe(
      'app_01KX8ZYZQ88VRTJZFAWPGNCCSX',
    )
  })

  it('returns null when the caller owns no app at this name (→ mint fresh)', async () => {
    mockApps([{ appId: 'app_x', name: 'somethingelse' }])
    expect(await resolveOwnedAppId('https://d', 't', 'brand-new-app')).toBeNull()
  })

  it('returns null (never throws) on a non-OK response', async () => {
    mockApps([], false)
    expect(await resolveOwnedAppId('https://d', 't', 'videostudio')).toBeNull()
  })

  it('returns null (never throws) when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    expect(await resolveOwnedAppId('https://d', 't', 'videostudio')).toBeNull()
  })
})
