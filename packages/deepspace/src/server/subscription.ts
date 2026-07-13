/**
 * Server-side subscription helpers. Called from the developer's worker
 * (Hono Context) — they proxy to the api-worker's `/api/subscriptions/me`
 * using the worker's signed app-identity headers, so the same trust
 * model the SDK hook uses applies here.
 */

import type { Context } from 'hono'
import { apiWorkerFetch } from './utils/proxies'
import type { ApiWorkerEnv } from './utils/proxies'
import { appendAppIdentity } from './utils/app-identity'
import { isEntitled, type PlanInfo, type SubscriptionStatus } from '../shared/subscription'

// Re-export shared types so consumers can import them from this barrel.
export type { PlanInfo, SubscriptionStatus }

export interface SubscriptionRead {
  tier: string
  status: SubscriptionStatus
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
  trialEndsAt: number | null
  plans: PlanInfo[]
}

interface StarterAppEnv extends ApiWorkerEnv {
  /** Absent until the app's first deploy registers it — see appendAppIdentity. */
  APP_IDENTITY_TOKEN?: string
  /** Immutable app id — the identity the platform verifies (HMAC input). */
  DEEPSPACE_APP_ID: string
}

function appIdentityHeaders(c: Context<{ Bindings: StarterAppEnv }>, extra?: Record<string, string>): Headers {
  const h = new Headers(extra ?? {})
  appendAppIdentity(h, c.env)
  // The api-worker's auth middleware only honors `Authorization: Bearer <jwt>`.
  // If the inbound request doesn't carry a Bearer, `/api/subscriptions/me`
  // will 401 — calling code should ensure the browser used `getAuthToken()`
  // or otherwise put a JWT on the request before reaching here.
  const authz = c.req.header('authorization')
  if (authz) h.set('authorization', authz)
  return h
}

export async function getSubscription(
  c: Context<{ Bindings: StarterAppEnv }>,
): Promise<SubscriptionRead> {
  const res = await apiWorkerFetch(c.env, '/api/subscriptions/me', {
    method: 'GET',
    headers: appIdentityHeaders(c),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    // 401/403 means the caller isn't authenticated or isn't allowed —
    // distinct from 5xx/network blips so route handlers can map it to a
    // 401 response instead of a 500. See `requireSubscription` docs example.
    if (res.status === 401 || res.status === 403) {
      throw new SubscriptionAuthError(
        body.error ?? `subscription auth failed (${res.status})`,
        res.status,
      )
    }
    throw new Error(body.error ?? `subscription read failed (${res.status})`)
  }
  return (await res.json()) as SubscriptionRead
}

/**
 * Enforce a tier gate inside a route. Throws `SubscriptionRequiredError` if
 * the caller's subscription doesn't meet the requested tier OR isn't currently
 * entitled (status ∈ {active, trialing}). Callers do
 * `await requireSubscription(c, { atLeast: 'pro' })` and let the thrown
 * response propagate.
 *
 * Why the status gate: a row with `planSlug='pro'` and `status='past_due'`
 * means "this user used to be on Pro but their payment is overdue" — paid
 * features should not unlock. Same for canceled/unpaid/incomplete.
 */
export async function requireSubscription(
  c: Context<{ Bindings: StarterAppEnv }>,
  opts: { tier?: string; atLeast?: string },
): Promise<SubscriptionRead> {
  const sub = await getSubscription(c)
  // Free-tier gates pass unconditionally; everything else needs entitlement.
  if (!isEntitled(sub.tier, sub.status)) {
    throw new SubscriptionRequiredError(opts.tier ?? opts.atLeast ?? 'paid', sub.tier)
  }
  if (opts.tier && sub.tier !== opts.tier) {
    throw new SubscriptionRequiredError(opts.tier, sub.tier)
  }
  if (opts.atLeast) {
    const target = sub.plans.find((p) => p.slug === opts.atLeast)?.rank
    const current = sub.plans.find((p) => p.slug === sub.tier)?.rank
    if (target == null || current == null || current < target) {
      throw new SubscriptionRequiredError(opts.atLeast, sub.tier)
    }
  }
  return sub
}

export class SubscriptionRequiredError extends Error {
  readonly required: string
  readonly current: string
  constructor(required: string, current: string) {
    super(`subscription tier required: ${required} (have: ${current})`)
    this.required = required
    this.current = current
    this.name = 'SubscriptionRequiredError'
  }
}

/**
 * Thrown by `getSubscription` / `requireSubscription` when the upstream
 * `/api/subscriptions/me` rejects the caller with 401 or 403 — typically
 * because the inbound request didn't carry a Bearer token, or carried one
 * the api-worker can't verify. Distinct from `SubscriptionRequiredError`
 * (which is about tier/entitlement, not identity) so route handlers can
 * map identity failures to 401 and tier failures to 402.
 */
export class SubscriptionAuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SubscriptionAuthError'
    this.status = status
  }
}

/**
 * Cancel one customer's subscription, or every subscription on a given plan.
 *
 * Forwards the inbound `Authorization` header — the platform verifies the
 * actor is the app owner before calling Stripe. As with `refundInvoice`,
 * gate this in your own admin route too; the platform check is the second
 * layer, not the first.
 *
 * Defaults to `atPeriodEnd: true` so customers aren't cut off mid-cycle.
 * Pass `atPeriodEnd: false` for an immediate cancel (refund handled
 * separately if you want one).
 */
export interface CancelSubscriptionOpts {
  /** Cancel one specific customer's subscription. Mutually exclusive with `planSlug`. */
  userId?: string
  /** Cancel every active subscription on this plan. Mutually exclusive with `userId`. */
  planSlug?: string
  /** Default true. Pass false for an immediate cancel. */
  atPeriodEnd?: boolean
  /** Optional free-form audit reason. */
  reason?: string
}

export interface CancelSubscriptionResult {
  success: boolean
  canceled: number
  failures: Array<{ stripeSubscriptionId: string; error: string }>
  atPeriodEnd: boolean
  /**
   * True when the matching subscription set was larger than the server-side
   * batch limit (currently 50). Loop the call until this returns false to
   * cancel every remaining row — the `cancel_at_period_end` flag is
   * idempotent, so re-flagging an already-flagged subscription is a no-op.
   */
  hasMore: boolean
}

export async function cancelSubscription(
  c: Context<{ Bindings: StarterAppEnv }>,
  opts: CancelSubscriptionOpts,
): Promise<CancelSubscriptionResult> {
  const authz = c.req.header('authorization')
  if (!authz) {
    throw new CancelSubscriptionError('missing authorization header (forward the caller JWT)', 401)
  }
  const res = await apiWorkerFetch(c.env, '/api/subscriptions/admin-cancel', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: authz,
    },
    body: JSON.stringify({
      appId: c.env.DEEPSPACE_APP_ID,
      userId: opts.userId,
      planSlug: opts.planSlug,
      atPeriodEnd: opts.atPeriodEnd,
      reason: opts.reason,
    }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new CancelSubscriptionError(
      body.error ?? `cancel failed (${res.status})`,
      res.status,
    )
  }
  return (await res.json()) as CancelSubscriptionResult
}

export class CancelSubscriptionError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'CancelSubscriptionError'
    this.status = status
  }
}
