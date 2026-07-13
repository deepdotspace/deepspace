/**
 * Subscription primitives shared between client (useSubscription hook) and
 * server (requireSubscription helper). Pulled into a shared module so the
 * entitlement gate has a single source of truth — if it ever diverges between
 * client and server, gated features silently disagree about who's allowed in,
 * which is a security bug, not a UX bug.
 */

export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid'
  | 'paused'

/** Per-interval price advertised by a plan. */
export interface PlanPrice {
  interval: 'month' | 'year'
  priceCents: number
  currency?: string
}

/**
 * Plan shape returned by `/api/subscriptions/me` and consumed directly by
 * `<PricingTable plans={sub.plans}>`. Fields beyond slug/rank are optional so
 * a free tier (no prices, no trial) doesn't need to fabricate them.
 */
export interface PlanInfo {
  slug: string
  rank: number
  name: string
  trialDays?: number | null
  prices: PlanPrice[]
}

// Statuses that grant access to paid features. Other statuses (past_due,
// unpaid, incomplete, paused, canceled) keep the user's recorded planSlug so
// the UI can surface "your Pro plan is past-due" — but they MUST NOT unlock.
//
// Typed as `ReadonlySet<string>` (not `Set<SubscriptionStatus>`) so callers
// passing a server-supplied string don't need a runtime cast; unknown statuses
// fall through as "not entitled", which is the safe default.
export const ENTITLED_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
])

/**
 * True iff the subscription currently grants access to paid features.
 *
 * - Free tier always counts as entitled — no payment required.
 * - Otherwise the status must be in `ENTITLED_STATUSES`.
 *
 * `status` is typed as `string` deliberately: server responses can carry
 * statuses we haven't enumerated yet (e.g. if Stripe adds a new one), and
 * those should fall through as not-entitled rather than crashing the check.
 */
export function isEntitled(tier: string, status: string): boolean {
  if (tier === 'free') return true
  return ENTITLED_STATUSES.has(status)
}
