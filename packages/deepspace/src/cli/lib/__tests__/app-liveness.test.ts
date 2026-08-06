/**
 * One answer to "is this app serving", shared by `status` and `app list`.
 *
 * The regression this pins: undeploy releases the routes and flips the
 * registry status but leaves the append-only release log untouched, so a
 * command that reads liveness from the last release reports a live URL for an
 * app the edge 404s.
 */

import { describe, expect, it } from 'vitest'
import { liveAppUrl, type AppListEntry } from '../app-target'

const entry = (over: Partial<AppListEntry> = {}): AppListEntry => ({
  appId: 'app_01JQ',
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  deployedAt: '2026-08-02T00:00:00.000Z',
  name: 'demo',
  url: 'https://demo.app.space',
  role: 'owner',
  ...over,
})

describe('liveAppUrl', () => {
  it('reports the URL for a deployed, active app', () => {
    expect(liveAppUrl(entry())).toBe('https://demo.app.space')
  })

  it('reports nothing after undeploy, which only flips status and drops routes', () => {
    // Exactly what `undeployApp` leaves behind: status undeployed, routes
    // released (so no url), and deployedAt deliberately preserved.
    expect(liveAppUrl(entry({ status: 'undeployed', name: null, url: null }))).toBeNull()
  })

  it('reports nothing for a registered app that never deployed', () => {
    expect(liveAppUrl(entry({ deployedAt: null, name: null, url: null }))).toBeNull()
  })

  it('reports nothing for a suspended app even while a route survives', () => {
    expect(liveAppUrl(entry({ status: 'suspended' }))).toBeNull()
  })
})
