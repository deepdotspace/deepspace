/**
 * Hostname detection decides which plane a page's sign-in and API calls go
 * to. A medical app's page must call the medical plane's sign-in and API,
 * never production's.
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
  it('sends medical apps and services to the medical plane', () => {
    expect(onHost('notes.deepspacemedical.app')).toEqual({
      plane: 'medical',
      authUrl: 'https://auth.deepspacemedical.com',
    })
    expect(onHost('auth.deepspacemedical.com').plane).toBe('medical')
    expect(onHost('deepspacemedical.com').plane).toBe('medical')
  })

  it('leaves production and look-alike hosts on production', () => {
    expect(onHost('notes.app.space')).toEqual({
      plane: 'prod',
      authUrl: 'https://auth.deep.space',
    })
    expect(onHost('notdeepspacemedical.app').plane).toBe('prod')
    expect(onHost('dashboard.deep.space').plane).toBe('prod')
  })

  it('keeps staging on staging', () => {
    expect(onHost('app.spacestest.com').plane).toBe('staging')
  })
})
