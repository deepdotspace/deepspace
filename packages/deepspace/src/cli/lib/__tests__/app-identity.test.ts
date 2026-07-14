import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveExistingAppId } from '../app-identity'

/** Stub fetch with per-endpoint behavior: the owned-apps list and the gated
 *  per-app analytics probe (`/analytics` → status). */
function mockEndpoints(opts: {
  apps?: Array<{ appId: string; name: string | null }>
  appsOk?: boolean
  analyticsStatus?: number
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/analytics')) {
        const status = opts.analyticsStatus ?? 404
        return { ok: status === 200, status, json: async () => ({}) } as unknown as Response
      }
      return {
        ok: opts.appsOk ?? true,
        status: opts.appsOk === false ? 500 : 200,
        json: async () => ({ apps: opts.apps ?? [] }),
      } as unknown as Response
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('resolveExistingAppId — adopt an existing app id instead of minting', () => {
  it('adopts the caller’s app id for a matching subdomain (the cutover case)', async () => {
    mockEndpoints({
      apps: [
        { appId: 'app_0000000000000000000000OTHER', name: 'otherapp' },
        { appId: 'app_01KX8ZYZQ88VRTJZFAWPGNCCSX', name: 'videostudio' },
      ],
    })
    expect(await resolveExistingAppId('https://d', 't', 'videostudio')).toEqual({
      kind: 'adopted',
      appId: 'app_01KX8ZYZQ88VRTJZFAWPGNCCSX',
      owned: true,
    })
  })

  it('adopts the legacy name-as-id when the caller can deploy on-behalf (collaborator/admin)', async () => {
    // The owned list misses (someone else owns it) but the gated per-app read
    // authorizes → the backfilled app's id IS the name.
    mockEndpoints({ apps: [{ appId: 'app_x', name: 'somethingelse' }], analyticsStatus: 200 })
    expect(await resolveExistingAppId('https://d', 't', 'deepdotspace-site')).toEqual({
      kind: 'adopted',
      appId: 'deepdotspace-site',
      owned: false,
    })
  })

  it('reports `taken` when the name belongs to an app the caller cannot deploy', async () => {
    mockEndpoints({ apps: [], analyticsStatus: 403 })
    expect(await resolveExistingAppId('https://d', 't', 'videostudio')).toEqual({ kind: 'taken' })
  })

  it('resolves `none` when nothing is registered at this name (→ mint fresh)', async () => {
    mockEndpoints({ apps: [{ appId: 'app_x', name: 'somethingelse' }], analyticsStatus: 404 })
    expect(await resolveExistingAppId('https://d', 't', 'brand-new-app')).toEqual({ kind: 'none' })
  })

  it('resolves `none` (never throws) when the owned list errors and the probe misses', async () => {
    mockEndpoints({ appsOk: false, analyticsStatus: 404 })
    expect(await resolveExistingAppId('https://d', 't', 'videostudio')).toEqual({ kind: 'none' })
  })

  it('still adopts via the probe when the owned-list call rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/analytics')) {
          return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
        }
        throw new Error('network down')
      }),
    )
    expect(await resolveExistingAppId('https://d', 't', 'videostudio')).toEqual({
      kind: 'adopted',
      appId: 'videostudio',
      owned: false,
    })
  })

  it('resolves `none` (never throws) when every call rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    expect(await resolveExistingAppId('https://d', 't', 'videostudio')).toEqual({ kind: 'none' })
  })
})
