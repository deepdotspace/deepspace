/**
 * One-time product declarations.
 *
 * Edit this file then `deepspace deploy` to sync the catalog to the platform.
 * Each row declares a `productId` (your entitlement key) and the amount the
 * platform will charge when `chargeOnce({ productId })` runs. The browser
 * cannot override these — the platform looks up amount/name from this list
 * at checkout time, so `useCheckout({ productId }).owned` is trustworthy.
 *
 * Drop a row to deactivate it (historical purchases keep working — the row
 * is marked inactive, not deleted).
 *
 * Minimum amount: 100 cents — below this Stripe fees eat the charge.
 */

export const oneTimeProducts = [
  // Example: one-time unlock you can gate features behind.
  // {
  //   productId: 'pro_unlock',
  //   name: 'Pro Unlock',
  //   amountCents: 1999,        // $19.99
  //   description: 'One-time purchase to unlock Pro features.',
  // },
] as const

export type ProductId = (typeof oneTimeProducts)[number] extends never
  ? string
  : (typeof oneTimeProducts)[number]['productId']
