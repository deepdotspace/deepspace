/**
 * deepspace app usage
 *
 * Shows the logged-in user's account-wide credit balance, quota headroom, and
 * per-integration spend — the CLI view of the dashboard's billing page. The
 * command is nested under `app` for compatibility; it is not scoped to the
 * app in the current directory.
 * Agents driving `deepspace integrations invoke` pay per call; this is how they check
 * the balance without a browser.
 *
 * Units: credits are the billing unit (100 credits = $1) and can be
 * fractional. Integration costs come back in USD — the marked-up figures
 * actually deducted from the balance. The balance covers the current
 * billing period; the per-integration table is a fixed 30-day window
 * (server-side).
 *
 * `--json` emits the /api/usage/summary response for scripts, inside the
 * standard `{ ok, … }` envelope.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, and the exit codes come from there, not from this file.
 */

import { ensureToken } from '../auth'
import { PLATFORM_URLS, DASHBOARD_URL } from '../env'
import { apiFetch } from '../lib/api'
import { defineDeepspaceCommand } from '../lib/command'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api

interface CreditBucket {
  allocation: number
  used: number
  remaining: number
}

export interface UsageSummary {
  credits: {
    credits: number
    totalUsed: number
    totalAllocation: number
    subscription: CreditBucket & { tier: string; renewsAt: string | null }
    bonus: CreditBucket & { expiresAt: string | null; expired: boolean }
    purchased: CreditBucket
  }
  usageByIntegration: { name: string; totalCost: number; count: number }[]
  /** Passed through on --json; not rendered in human output. */
  recentUsage: unknown[]
}

/**
 * Credits accrue in fractions (a small call can be 0.65 credits). Mirrors
 * the dashboard's CreditsMeter formatting so both surfaces read the same.
 */
export function formatCredits(value: number): string {
  if (value > 0 && value < 1) return '<1'
  if (value < 10) return value.toFixed(1).replace(/\.0$/, '')
  return Math.round(value).toLocaleString('en-US')
}

/** Integration costs are often sub-cent; show 4 decimals below $0.01. */
export function formatUsd(value: number): string {
  return `$${Math.abs(value) >= 0.01 || value === 0 ? value.toFixed(2) : value.toFixed(4)}`
}

// UTC so the printed date matches the ISO timestamp regardless of the
// machine's timezone (a midnight-UTC renewal shouldn't shift a day).
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function renderSummary(summary: UsageSummary): string {
  const { credits, usageByIntegration } = summary
  const lines: string[] = []

  lines.push('Account usage (all apps)')
  lines.push('')

  const renews = credits.subscription.renewsAt
    ? ` · renews ${formatDate(credits.subscription.renewsAt)}`
    : ''
  lines.push(`Plan:     ${credits.subscription.tier}${renews}`)
  lines.push(
    `Credits:  ${formatCredits(credits.credits)} of ${formatCredits(credits.totalAllocation)} remaining (100 credits = $1)`,
  )

  // A bucket breakdown only earns space when a pool beyond the subscription
  // is in play — otherwise it would just repeat the Credits line.
  const bonusActive = credits.bonus.allocation > 0 || credits.bonus.expired
  const purchasedActive = credits.purchased.allocation > 0 || credits.purchased.used > 0
  if (bonusActive || purchasedActive) {
    const bucket = (b: CreditBucket) =>
      `${formatCredits(b.remaining)} of ${formatCredits(b.allocation)} remaining`
    lines.push(`  Subscription:  ${bucket(credits.subscription)}`)
    if (bonusActive) {
      const expires = credits.bonus.expiresAt
        ? ` · expires ${formatDate(credits.bonus.expiresAt)}`
        : ''
      lines.push(
        `  Bonus:         ${credits.bonus.expired ? 'expired' : bucket(credits.bonus) + expires}`,
      )
    }
    if (purchasedActive) {
      lines.push(`  Purchased:     ${bucket(credits.purchased)}`)
    }
  }

  lines.push('')
  if (!usageByIntegration.length) {
    lines.push('No integration usage in the last 30 days.')
  } else {
    lines.push('Usage by integration (last 30 days):')
    const nameWidth = Math.max(11, ...usageByIntegration.map((u) => u.name.length))
    lines.push(`${'INTEGRATION'.padEnd(nameWidth)}  CALLS  COST`)
    for (const u of usageByIntegration) {
      lines.push(
        `${u.name.padEnd(nameWidth)}  ${String(u.count).padEnd(5)}  ${formatUsd(u.totalCost)}`,
      )
    }
  }

  lines.push('')
  lines.push(`Dashboard: ${DASHBOARD_URL}`)
  return lines.join('\n')
}

export default defineDeepspaceCommand({
  meta: {
    name: 'usage',
    description:
      'Show account-wide credits and integration spend (all apps). Storage is per app: `deepspace app files list`',
  },
  async run({ args }) {
    const token = await ensureToken()
    const summary = await apiFetch<UsageSummary>(API_URL, token, '/api/usage/summary')

    if (!args.json) console.log(renderSummary(summary))
    // No `next`: reading the balance is terminal — topping up happens in the
    // dashboard, which the human output already links.
    return { data: { scope: 'account', ...summary } }
  },
})
