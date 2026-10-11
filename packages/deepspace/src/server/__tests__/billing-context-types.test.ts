/**
 * Type-level contract: the billing helpers accept an app's own Hono context.
 * Hono's Context is invariant in its env, so these were previously typed
 * against a minimal env and rejected every real `Context<{ Bindings: Env }>`.
 */

import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import { cancelSubscription, getSubscription, requireSubscription } from '../subscription'
import { refundInvoice } from '../refunds'

interface AppEnv {
  ASSETS: Fetcher
  DEEPSPACE_APP_ID: string
  APP_IDENTITY_TOKEN?: string
  API_WORKER?: Fetcher
  API_WORKER_URL?: string
  OWNER_USER_ID: string
}

describe('billing helpers accept the app context', () => {
  it('typechecks against Context<{ Bindings: AppEnv }>', () => {
    const use = (c: Context<{ Bindings: AppEnv }>) => [
      getSubscription(c),
      requireSubscription(c, { atLeast: 'pro' }),
      cancelSubscription(c, { userId: 'u' }),
      refundInvoice(c, { invoiceId: 'i' }),
    ]
    expect(typeof use).toBe('function')
  })

  it('still rejects a context without the app identity', () => {
    const use = (c: Context<{ Bindings: { ASSETS: Fetcher } }>) =>
      // @ts-expect-error DEEPSPACE_APP_ID is required to sign the request
      getSubscription(c)
    expect(typeof use).toBe('function')
  })
})
