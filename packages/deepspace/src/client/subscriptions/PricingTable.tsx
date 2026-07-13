// Minimal pre-fab pricing UI. Stateless: pass in `plans` from
// `useSubscription().plans` and an `onSelect` callback that calls
// `useSubscription().subscribe()`. Apps that want their own design can ignore
// this and roll their own; this is just the "works out of the box" path for
// starter apps.

import type { PlanInfo, PlanPrice } from '../../shared/subscription'

// Re-export shared types so callers can do
// `import { PricingTablePlan } from 'deepspace'` without reaching into shared.
export type PricingTablePrice = PlanPrice
export type PricingTablePlan = PlanInfo

export function PricingTable(props: {
  plans: PricingTablePlan[]
  interval?: 'month' | 'year'
  currentTier?: string
  onSelect: (planSlug: string, interval: 'month' | 'year') => void | Promise<void>
}) {
  const interval = props.interval ?? 'month'
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {props.plans.map((plan) => {
        const price = plan.prices.find((p) => p.interval === interval)
        const selected = props.currentTier === plan.slug
        // A plan is truly free only if it has no priced interval at all.
        // If `price` is missing but the plan has prices on OTHER intervals,
        // this interval is unavailable — clicking checkout would fail with
        // `unknown_price`, so we render "Unavailable" and disable the button
        // instead of mislabeling it as free.
        const isTrueFree = plan.prices.length === 0
        const otherIntervals = plan.prices
          .map((p) => p.interval)
          .filter((i) => i !== interval)
        const intervalUnavailable = !price && !isTrueFree
        const onlyInterval = otherIntervals.length === 1 ? otherIntervals[0] : null
        const unavailableLabel = onlyInterval
          ? onlyInterval === 'month'
            ? 'Monthly only'
            : 'Yearly only'
          : 'Unavailable'
        const priceLabel = price
          ? `$${(price.priceCents / 100).toFixed(0)}`
          : isTrueFree
            ? 'Free'
            : unavailableLabel
        const disabled = selected || intervalUnavailable
        return (
          <section key={plan.slug} className="rounded-lg border border-border p-5">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              <p className="text-3xl font-semibold">
                {priceLabel}
                <span className="text-sm font-normal text-muted-foreground">
                  {price ? `/${interval}` : ''}
                </span>
              </p>
              {plan.trialDays ? (
                <p className="text-xs text-muted-foreground">{plan.trialDays}-day free trial</p>
              ) : null}
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void props.onSelect(plan.slug, interval)}
              className="mt-5 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {selected
                ? 'Current plan'
                : intervalUnavailable
                  ? unavailableLabel
                  : 'Select plan'}
            </button>
          </section>
        )
      })}
    </div>
  )
}
