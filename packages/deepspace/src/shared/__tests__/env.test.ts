/**
 * Hostname detection decides which plane a page's sign-in and API calls go
 * to. A staging page must never call production, and production pages must
 * stay on production.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectEnvironment, getEnvironmentConfig, resetEnvironmentCache } from '../env'

function onHost(hostname: string) {
  resetEnvironmentCache()
  vi.stubGlobal('window', { location: { hostname } })
  return { plane: detectEnvironment(), authUrl: getEnvironmentConfig().authUrl }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetEnvironmentCache()
})

describe('plane detection by hostname', () => {
  it('keeps production apps and services on production', () => {
    expect(onHost('notes.app.space')).toEqual({ plane: 'prod', authUrl: 'https://auth.deep.space' })
    expect(onHost('dashboard.deep.space').plane).toBe('prod')
  })

  it('sends staging apps and services to staging', () => {
    expect(onHost('notes.spacestest.com')).toEqual({
      plane: 'staging',
      authUrl: 'https://auth.deepspacesites.com',
    })
    expect(onHost('auth.deepspacesites.com').plane).toBe('staging')
  })

  it('does not treat a look-alike host as staging', () => {
    expect(onHost('notspacestest.com').plane).toBe('prod')
  })
})
