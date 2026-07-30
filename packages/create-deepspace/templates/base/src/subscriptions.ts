/**
 * Subscription plan declarations.
 *
 * Add paid tiers here, then `deepspace deploy` to sync them to Stripe Products
 * and Prices. Keep each `slug` stable; subscribers and tier checks refer to it.
 * Users sit on the built-in "free" tier until they subscribe, so declare a free
 * plan only if you want it listed alongside your paid ones.
 *
 * Minimum prices: $3/month, $12/year. Below that Stripe's per-transaction fee
 * ($0.30 + 2.9%) eats most of the charge, so you would receive almost nothing
 * per payout. A plan with priceCents: 0 never hits Stripe.
 */

export const subscriptionPlans = [
  // Example paid tier. Uncomment, edit, then `deepspace deploy` to sync it to
  // Stripe. Once a paid plan exists, earnings queue in your platform balance
  // until you finish Stripe Connect onboarding at /earnings.
  // {
  //   slug: 'pro',
  //   name: 'Pro',
  //   priceCents: 900,           // $9/month
  //   yearlyCents: 9000,         // optional, $90/year (drop for month-only)
  //   taxCode: 'txcd_10000000',  // optional, defaults to this (digital services)
  // },
] as const

export type SubscriptionPlanSlug = (typeof subscriptionPlans)[number] extends never
  ? string
  : (typeof subscriptionPlans)[number]['slug']
