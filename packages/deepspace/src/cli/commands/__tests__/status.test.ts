import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError } from '../../lib/api'
import { resolveStatusApp, statusRemoteFailure } from '../status'

describe('statusRemoteFailure', () => {
  it('preserves an app-not-found response instead of calling it unreachable', () => {
    const failure = statusRemoteFailure(
      new ApiError(
        'App is not registered — deploy or push from the owning account first',
        404,
        'app_not_found',
      ),
    )

    expect(failure).toEqual({
      human: 'App is not registered — deploy or push from the owning account first [app_not_found]',
      json: {
        state: 'unavailable',
        code: 'app_not_found',
        error: 'App is not registered — deploy or push from the owning account first',
      },
    })
  })

  it('keeps network failures visibly unreachable in both output forms', () => {
    const failure = statusRemoteFailure(
      new ApiError('Could not reach the deploy service', 0, 'network_error'),
    )

    expect(failure).toEqual({
      human: '(unreachable) — Could not reach the deploy service [network_error]',
      json: {
        state: 'unavailable',
        code: 'network_error',
        error: 'Could not reach the deploy service',
      },
    })
  })

  it('retains an untyped upstream message without inventing a code', () => {
    expect(statusRemoteFailure(new Error('socket closed'))).toEqual({
      human: 'socket closed',
      json: { state: 'unavailable', error: 'socket closed' },
    })
  })
})

describe('resolveStatusApp', () => {
  it('selects the name and app id from one named Wrangler environment', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-status-env-'))
    writeFileSync(
      join(appDir, 'wrangler.toml'),
      `
name = "example"
[vars]
DEEPSPACE_APP_ID = "app_production"

[env.staging]
name = "example-staging"
[env.staging.vars]
DEEPSPACE_APP_ID = "app_01KZ84H3TC7ZX9P8V829MDFY5Y"
`,
    )

    expect(resolveStatusApp(appDir, 'staging')).toEqual({
      appName: 'example-staging',
      appId: 'app_01KZ84H3TC7ZX9P8V829MDFY5Y',
    })
  })
})
