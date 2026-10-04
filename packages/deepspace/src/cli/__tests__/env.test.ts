import { describe, expect, it } from 'vitest'
import {
  PLANE_AUTH_URLS,
  effectivePlatformUrls,
  platformDomainForEnv,
  resolveDeepSpaceEnvironment,
} from '../env'

describe('environment selection', () => {
  it('defaults only an unset value to production', () => {
    expect(resolveDeepSpaceEnvironment(undefined)).toBe('production')
    expect(resolveDeepSpaceEnvironment('production')).toBe('production')
  })

  it('selects staging explicitly and rejects every unknown explicit value', () => {
    expect(resolveDeepSpaceEnvironment('staging')).toBe('staging')
    expect(resolveDeepSpaceEnvironment('medical')).toBe('medical')
    expect(resolveDeepSpaceEnvironment('Medical')).toBe('invalid')
    expect(resolveDeepSpaceEnvironment('stage')).toBe('invalid')
    expect(resolveDeepSpaceEnvironment('')).toBe('invalid')
  })

  it('reports the actual per-service overrides', () => {
    expect(
      effectivePlatformUrls({
        DEEPSPACE_AUTH_URL: 'https://auth.example.test',
        DEEPSPACE_DEPLOY_URL: 'https://deploy.example.test',
      }),
    ).toMatchObject({
      auth: 'https://auth.example.test',
      deploy: 'https://deploy.example.test',
    })
  })
})

describe('medical plane', () => {
  it('puts its services under deepspacemedical.com with its own sign-in', () => {
    expect(platformDomainForEnv('medical')).toBe('deepspacemedical.com')
    expect(PLANE_AUTH_URLS.medical).toBe('https://auth.deepspacemedical.com')
    expect(new Set(Object.values(PLANE_AUTH_URLS)).size).toBe(Object.keys(PLANE_AUTH_URLS).length)
  })
})
