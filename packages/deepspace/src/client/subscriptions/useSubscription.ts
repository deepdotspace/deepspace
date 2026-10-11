// Per-app subscription state hook. Reads through the starter's same-origin
// /_deepspace proxy, which signs with the app identity token.

import { useCallback, useEffect, useRef, useState } from 'react'
import { authedJson } from '../authed-json'
import { useAuth } from '../auth/hooks'
import { apiErrorCode, PlatformApiError } from '../../shared/api-error'
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
  /** Human-readable text of the last load failure, safe to render. */
  error: string | null
  /**
   * Machine slug of the last load failure (e.g. 'owner_connect_not_ready')
   * for branching — never render it. Null when there is no error or the
   * failure carried no slug (e.g. a network drop).
   */
  errorCode: string | null
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
  /** Plan catalog from /me; PricingTable also requires an onSelect callback. */
  plans: PlanInfo[]
  subscribe: (planSlug: string, opts?: SubscribeOpts) => Promise<SubscribeResult>
  openPortal: (returnUrl?: string) => Promise<{ url: string }>
  refresh: () => Promise<void>
}

const SIGNED_OUT_STATE: SubscriptionState = {
  tier: 'free',
  status: 'none',
  interval: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  trialEndsAt: null,
  plans: [],
}

/** The refusal for a billing action attempted while nobody is signed in. */
function signedOutError(): PlatformApiError {
  return new PlatformApiError({
    error: 'Sign in to manage a subscription.',
    code: 'unauthorized',
    status: 401,
  })
}

export function useSubscription(): UseSubscriptionReturn {
  const { isLoaded, userId } = useAuth()
  const [state, setState] = useState<SubscriptionState>(SIGNED_OUT_STATE)
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)

  // `/me` answers for whoever is signed in when it is sent. A response that
  // lands after the user changed (sign-out, account switch) or after a newer
  // read started describes someone else, so only the latest request for the
  // current user may write state.
  const userRef = useRef<string | null>(null)
  const loadedRef = useRef(false)
  const requestRef = useRef(0)
  userRef.current = userId
  loadedRef.current = isLoaded

  const resetSignedOut = useCallback(() => {
    requestRef.current += 1
    setState(SIGNED_OUT_STATE)
    setError(null)
    setErrorCode(null)
    setLoading(false)
  }, [])

  const refresh = useCallback(async () => {
    // Before auth resolves nobody is known to be signed in or out; the
    // effect below reads as soon as it does.
    if (!loadedRef.current) return
    const forUser = userRef.current
    // A signed-out visitor has no subscription to read: asking anyway only
    // produced a 401, an error state, and console noise on public pages.
    if (!forUser) {
      resetSignedOut()
      return
    }
    const request = ++requestRef.current
    const current = () => requestRef.current === request && userRef.current === forUser
    setLoading(true)
    try {
      const r = await authedJson<SubscriptionState>('/_deepspace/subscriptions/me')
      if (!current()) return
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
      setErrorCode(null)
    } catch (e) {
      if (!current()) return
      setError(e instanceof Error ? e.message : 'Failed to load subscription')
      setErrorCode(apiErrorCode(e))
    } finally {
      if (current()) setLoading(false)
    }
  }, [resetSignedOut])

  // Read once auth resolves and again whenever the user changes. A new user
  // starts from the free state, never from the previous user's tier.
  useEffect(() => {
    if (!isLoaded) return
    if (!userId) {
      resetSignedOut()
      return
    }
    setState(SIGNED_OUT_STATE)
    setError(null)
    setErrorCode(null)
    void refresh()
  }, [isLoaded, userId, refresh, resetSignedOut])

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
      if (loadedRef.current && !userRef.current) throw signedOutError()
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

  const openPortal = useCallback(async (returnUrl?: string) => {
    if (loadedRef.current && !userRef.current) throw signedOutError()
    return authedJson<{ url: string }>('/_deepspace/subscriptions/portal', {
      method: 'POST',
      body: JSON.stringify({ returnUrl: returnUrl ?? window.location.href }),
    })
  }, [])

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
    errorCode,
    hasTier,
    isAtLeast,
    plans: state.plans,
    subscribe,
    openPortal,
    refresh,
  }
}
