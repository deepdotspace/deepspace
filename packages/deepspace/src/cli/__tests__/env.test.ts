import { describe, expect, it } from 'vitest'
import { effectivePlatformUrls, resolveDeepSpaceEnvironment } from '../env'

describe('environment selection', () => {
  it('defaults only an unset value to production', () => {
    expect(resolveDeepSpaceEnvironment(undefined)).toBe('production')
    expect(resolveDeepSpaceEnvironment('production')).toBe('production')
  })

  it('selects staging explicitly and rejects every unknown explicit value', () => {
    expect(resolveDeepSpaceEnvironment('staging')).toBe('staging')
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
