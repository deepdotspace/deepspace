// Server-side refund helper. Forwards the inbound user's JWT to the platform,
// which verifies the caller is the app owner before any Stripe call. Wrap
// your route with admin/role gating before calling refundInvoice — only the
// app owner's JWT will pass the platform's `not_app_owner` check, but you
// still want to reject non-admin paths in your own app's auth.

import type { Context } from 'hono'
import { apiWorkerFetch } from './utils/proxies'
import type { ApiWorkerEnv } from './utils/proxies'
import { appendAppIdentity } from './utils/app-identity'

interface StarterAppEnv extends ApiWorkerEnv {
  /** Absent until the app's first deploy registers it — see appendAppIdentity. */
  APP_IDENTITY_TOKEN?: string
  /** Immutable app id — the identity the platform verifies (HMAC input). */
  DEEPSPACE_APP_ID: string
}

export interface RefundResult {
  success: boolean
  stripeRefundId: string
  amountRefunded: number
  status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action' | null
}

export interface RefundOpts {
  invoiceId: string
  amount?: number
  reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent'
  requestNonce?: string
}

export async function refundInvoice(
  c: Context<{ Bindings: StarterAppEnv }>,
  opts: RefundOpts,
): Promise<RefundResult> {
  // The platform requires a verified actor — forward the inbound user's JWT.
  // No JWT → the helper can't authenticate; let the platform return 401 so
  // the caller gets a clear error rather than a silent no-op.
  const authz = c.req.header('authorization')
  const nonce = opts.requestNonce ?? crypto.randomUUID()
  const headers = new Headers({ 'Content-Type': 'application/json' })
  appendAppIdentity(headers, c.env)
  if (authz) headers.set('authorization', authz)
  const res = await apiWorkerFetch(c.env, '/api/refunds/create', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      invoiceId: opts.invoiceId,
      amount: opts.amount,
      reason: opts.reason,
      requestNonce: nonce,
    }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new RefundError(body.error ?? `refund failed (${res.status})`, res.status)
  }
  return (await res.json()) as RefundResult
}

export class RefundError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'RefundError'
    this.status = status
  }
}
