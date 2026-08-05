import { describe, expect, it, vi } from 'vitest'
import {
  checkDocumentationPublicLimit,
  type DocumentationPublicLimiterEnv,
} from '../public-limiter'

function environment(clientSuccess = true, appSuccess = true) {
  const clientLimit = vi.fn(async () => ({ success: clientSuccess }))
  const appLimit = vi.fn(async () => ({ success: appSuccess }))
  return {
    env: {
      DEEPSPACE_APP_ID: 'app_test',
      DOCUMENTATION_CLIENT_RATE_LIMITER: { limit: clientLimit },
      DOCUMENTATION_APP_RATE_LIMITER: { limit: appLimit },
    } as DocumentationPublicLimiterEnv,
    clientLimit,
    appLimit,
  }
}

describe('documentation public rate limits', () => {
  it('isolates client and app counters by the immutable app id', async () => {
    const { env, clientLimit, appLimit } = environment()

    await expect(checkDocumentationPublicLimit(env, 'client-hash', 'test')).resolves.toEqual({
      ok: true,
    })
    expect(clientLimit).toHaveBeenCalledWith({ key: 'app_test:client-hash' })
    expect(appLimit).toHaveBeenCalledWith({ key: 'app_test' })
  })

  it('stops at the client budget before consuming the app budget', async () => {
    const { env, appLimit } = environment(false)

    await expect(checkDocumentationPublicLimit(env, 'client-hash', 'test')).resolves.toEqual({
      ok: false,
      status: 429,
    })
    expect(appLimit).not.toHaveBeenCalled()
  })

  it('fails closed when either binding is absent or unavailable', async () => {
    await expect(
      checkDocumentationPublicLimit({ DEEPSPACE_APP_ID: 'app_test' }, 'client-hash', 'test'),
    ).resolves.toEqual({ ok: false, status: 503 })

    const { env } = environment()
    env.DOCUMENTATION_CLIENT_RATE_LIMITER = {
      limit: vi.fn(async () => {
        throw new Error('binding unavailable')
      }),
    }
    await expect(checkDocumentationPublicLimit(env, 'client-hash', 'test')).resolves.toEqual({
      ok: false,
      status: 503,
    })
  })
})
