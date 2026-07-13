// One-time charge hook. Two modes:
//
//   1. Server-declared product (`chargeOnce({ productId })`): the platform
//      resolves amount/name from your declared product catalog. The browser
//      can't pick `productId` + `amount` together — only the declared
//      amount is charged. This is the only entitlement-safe mode:
//      `useCheckout({productId}).owned` answers truthfully.
//
//   2. Ad-hoc (`chargeOnce({ amount, name })`): tips, donations, dynamic
//      amounts. The resulting invoice has no `productId` so `ownsProduct()`
//      cannot satisfy gating against it. Use for collection, not unlock.
//
// To declare products, POST to `/api/charges/products/sync` from a deploy
// step or admin tool with `{appName, products: [{productId, name,
// amountCents}]}`. Products dropped from a later sync are deactivated.
//
// The hook fetches the customer's purchase history on mount, caches it in
// state, and exposes `owned` + `ownsProduct(id)` for gating features behind
// a one-time purchase the same way `useSubscription().tier` gates behind a
// recurring plan.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getAuthToken } from '../auth/token'

interface ChargeRedirectOpts {
  /** Defaults to window.location.href. */
  returnUrl?: string
  /** Defaults to window.location.href. */
  cancelUrl?: string
}

/**
 * Product-mode charge: amount, name, and currency are resolved server-side
 * from the developer's declared product catalog (`src/products.ts`). The
 * browser cannot influence the price — this is the only entitlement-safe
 * shape because `useCheckout({productId}).owned` can be trusted afterwards.
 */
export interface ProductChargeOpts extends ChargeRedirectOpts {
  productId: string
}

/**
 * Ad-hoc charge: tips, donations, "name your price". Caller supplies the
 * amount and display name; the resulting invoice has `productId=null`, so
 * `ownsProduct()` will never report ownership against it. Use for revenue
 * collection, not for feature gating.
 */
export interface AdHocChargeOpts extends ChargeRedirectOpts {
  /** Amount in cents. Minimum 100 (Stripe fees eat smaller amounts). */
  amount: number
  /** Product name shown in Checkout and on the customer's receipt. */
  name: string
  /** Optional description rendered under the product name. */
  description?: string
  /** Must be omitted in ad-hoc mode — the never type makes the union disjoint. */
  productId?: never
}

/**
 * `chargeOnce` accepts either a `productId` (server-resolves price/name) or
 * an `amount`+`name` pair (ad-hoc). The two are mutually exclusive at the
 * type level so the safe path doesn't require dummy amount/name fields.
 */
export type ChargeOnceOpts = ProductChargeOpts | AdHocChargeOpts

export interface ChargeOnceResult {
  url: string
}

export interface Purchase {
  /** Internal invoice row id. Stable across refetches. */
  id: string
  /** Developer-supplied product id, or null for pre-entitlement rows. */
  productId: string | null
  /** Display name captured at checkout time. */
  name: string
  /** Amount paid in cents (post-tax — uses Stripe's `amount_total`). */
  amount: number
  currency: string
  /** ISO timestamp of the payment. */
  paidAt: string
}

export interface UseCheckoutOpts {
  /**
   * Product id to derive `owned` against. Without this, `owned` is always
   * false — the hook still surfaces `purchases` and `ownsProduct` for
   * callers that need to ask about more than one product.
   */
  productId?: string
}

interface UseCheckoutReturn {
  // Action surface
  chargeOnce: (opts: ChargeOnceOpts) => Promise<ChargeOnceResult>
  isLoading: boolean
  error: string | null

  // Read surface
  purchases: Purchase[]
  /** True iff `opts.productId` was provided and a non-fully-refunded row matches. */
  owned: boolean
  /** Pure function over the in-memory `purchases` array. No network. */
  ownsProduct: (productId: string) => boolean
  /** Re-fetch the purchase list. Useful right after a successful checkout. */
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

export function useCheckout(opts?: UseCheckoutOpts): UseCheckoutReturn {
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // No productId param on the fetch — the hook caches the full list and the
  // per-product question is answered in-memory. Cheaper than refetching on
  // every productId change and lets one component check ownership of N
  // products without N requests.
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await authedJson<{ purchases: Purchase[] }>(
        '/_deepspace/charges/me',
      )
      setPurchases(r.purchases ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load purchases')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const chargeOnce = useCallback(
    async (chargeOpts: ChargeOnceOpts): Promise<ChargeOnceResult> => {
      // Note: isLoading intentionally not toggled here — it tracks the
      // fetch lifecycle (initial + refresh), not the chargeOnce redirect.
      // Mirrors the v1 semantics callers already depend on.
      setError(null)

      // Build the request body by mode. In product mode we deliberately
      // omit amount/name from the wire — the server resolves them from the
      // declared catalog and would ignore client values anyway, but sending
      // them keeps the dangerous "browser picks the price" shape on the
      // wire. In ad-hoc mode we send what the caller supplied.
      const common = {
        returnUrl: chargeOpts.returnUrl ?? window.location.href,
        cancelUrl: chargeOpts.cancelUrl ?? window.location.href,
        requestNonce: crypto.randomUUID(),
      }
      const body =
        chargeOpts.productId !== undefined
          ? { ...common, productId: chargeOpts.productId }
          : {
              ...common,
              amount: chargeOpts.amount,
              name: chargeOpts.name,
              ...(chargeOpts.description ? { description: chargeOpts.description } : {}),
            }

      try {
        const result = await authedJson<{ url: string }>(
          '/_deepspace/charges/create',
          {
            method: 'POST',
            body: JSON.stringify(body),
          },
        )
        if (typeof window !== 'undefined' && result.url) {
          window.location.href = result.url
        }
        return result
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Failed to start checkout'
        setError(msg)
        throw e
      }
    },
    [],
  )

  const ownsProduct = useCallback(
    (productId: string) => purchases.some((p) => p.productId === productId),
    [purchases],
  )

  // `owned` is the convenience binding for the single-product case. Vacuously
  // false when no productId was passed to the hook — the caller didn't ask a
  // question, so the answer is "no entitlement".
  const owned = useMemo(
    () => !!opts?.productId && purchases.some((p) => p.productId === opts.productId),
    [opts?.productId, purchases],
  )

  return {
    chargeOnce,
    isLoading,
    error,
    purchases,
    owned,
    ownsProduct,
    refresh,
  }
}
