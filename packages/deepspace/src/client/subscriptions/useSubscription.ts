// Per-app subscription state hook. Reads through the starter's same-origin
// /_deepspace proxy, which signs with the app identity token.

import { useCallback, useEffect, useState } from 'react'
import { getAuthToken } from '../auth/token'
import { isEntitled, type PlanInfo, type SubscriptionStatus } from '../../shared/subscription'

// Re-export for SDK consumers — these are public types the hook is generic over.
export type { SubscriptionStatus, PlanInfo }

export interface SubscriptionState {
  tier: string
  status: SubscriptionStatus
  /** Billing interval of the active subscription, or null for free / no sub. */
  interval: 'month' | 'year' | null
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
  trialEndsAt: number | null
  plans: PlanInfo[]
}

export interface SubscribeOpts {
  interval?: 'month' | 'year'
  returnUrl?: string
  cancelUrl?: string
}

export interface SubscribeResult {
  url: string | null
  immediate: boolean
  requiresPayment?: boolean
  hostedInvoiceUrl?: string | null
}

interface UseSubscriptionReturn {
  tier: string
  status: SubscriptionStatus
  /**
   * True iff status is `active` or `trialing`. `hasTier` and `isAtLeast`
   * already encode this — read `entitled` only when you need the raw boolean
   * without picking a tier.
   */
  entitled: boolean
  /** Current billing interval, or null when on free / no subscription. */
  interval: 'month' | 'year' | null
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
  trialEndsAt: number | null
  isLoading: boolean
  error: string | null
  /**
   * Returns true only when `tier === slug` AND the subscription is currently
   * entitled (status ∈ {active, trialing}). A `past_due` / `canceled` /
   * `unpaid` subscription that still has a stored paid tier returns false.
   * The free tier is always entitled.
   */
  hasTier: (slug: string) => boolean
  /**
   * Returns true when the tier's rank meets-or-exceeds `slug` AND the
   * subscription is currently entitled. Same entitlement gate as `hasTier`.
   */
  isAtLeast: (slug: string) => boolean
  /** Plan catalog from /me — pass into `<PricingTable plans={...}>` directly. */
  plans: PlanInfo[]
  subscribe: (planSlug: string, opts?: SubscribeOpts) => Promise<SubscribeResult>
  openPortal: (returnUrl?: string) => Promise<{ url: string }>
  refresh: () => Promise<void>
}

async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken()
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error((data.error as string) ?? `Request failed (${res.status})`)
  }
  return data as T
}

export function useSubscription(): UseSubscriptionReturn {
  const [state, setState] = useState<SubscriptionState>({
    tier: 'free',
    status: 'none',
    interval: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    plans: [],
  })
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await authedJson<SubscriptionState>('/_deepspace/subscriptions/me')
      setState({
        tier: r.tier,
        status: r.status,
        interval: r.interval ?? null,
        currentPeriodEnd: r.currentPeriodEnd,
        cancelAtPeriodEnd: r.cancelAtPeriodEnd,
        trialEndsAt: r.trialEndsAt,
        plans: r.plans ?? [],
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load subscription')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const entitled = isEntitled(state.tier, state.status)
  const hasTier = useCallback(
    (slug: string) => state.tier === slug && isEntitled(state.tier, state.status),
    [state.tier, state.status],
  )
  const isAtLeast = useCallback(
    (slug: string) => {
      if (!isEntitled(state.tier, state.status)) return false
      const targetRank = state.plans.find((p) => p.slug === slug)?.rank
      const currentRank = state.plans.find((p) => p.slug === state.tier)?.rank
      if (targetRank == null || currentRank == null) return false
      return currentRank >= targetRank
    },
    [state.plans, state.tier, state.status],
  )

  const subscribe = useCallback(
    async (planSlug: string, opts?: SubscribeOpts): Promise<SubscribeResult> => {
      const result = await authedJson<SubscribeResult>('/_deepspace/subscriptions/checkout', {
        method: 'POST',
        body: JSON.stringify({
          planSlug,
          interval: opts?.interval ?? 'month',
          returnUrl: opts?.returnUrl ?? window.location.href,
          cancelUrl: opts?.cancelUrl ?? window.location.href,
          requestNonce: crypto.randomUUID(),
        }),
      })
      if (result.immediate) await refresh()
      // Auto-redirect when the server tells us to navigate. `result.url` is
      // populated in every redirect-bound case: Stripe Checkout session URL
      // (new sub), returnUrl (immediate in-place tier/interval change), and
      // hostedInvoiceUrl (SCA-pending proration). Matches useCheckout's
      // chargeOnce behavior so docs that show `await sub.subscribe('pro')`
      // and expect a redirect actually work without extra plumbing.
      if (typeof window !== 'undefined' && result.url) {
        window.location.href = result.url
      }
      return result
    },
    [refresh],
  )

  const openPortal = useCallback(
    async (returnUrl?: string) => {
      return authedJson<{ url: string }>('/_deepspace/subscriptions/portal', {
        method: 'POST',
        body: JSON.stringify({ returnUrl: returnUrl ?? window.location.href }),
      })
    },
    [],
  )

  return {
    tier: state.tier,
    status: state.status,
    entitled,
    interval: state.interval,
    currentPeriodEnd: state.currentPeriodEnd,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    trialEndsAt: state.trialEndsAt,
    isLoading,
    error,
    hasTier,
    isAtLeast,
    plans: state.plans,
    subscribe,
    openPortal,
    refresh,
  }
}
