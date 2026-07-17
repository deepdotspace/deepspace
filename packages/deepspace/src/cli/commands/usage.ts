/**
 * deepspace usage
 *
 * Shows the logged-in user's credit balance, quota headroom, and
 * per-integration spend — the CLI view of the dashboard's billing page.
 * Agents driving `deepspace invoke` pay per call; this is how they check
 * the balance without a browser.
 *
 * Units: credits are the billing unit (100 credits = $1) and can be
 * fractional. Integration costs come back in USD — the marked-up figures
 * actually deducted from the balance. The balance covers the current
 * billing period; the per-integration table is a fixed 30-day window
 * (server-side).
 *
 * `--json` emits the raw /api/usage/summary response for scripts.
 */

import { defineCommand } from 'citty'
import { ensureToken } from '../auth'
import { PLATFORM_URLS, DASHBOARD_URL } from '../env'
import { apiFetch } from '../lib/api'

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
      lines.push(`${u.name.padEnd(nameWidth)}  ${String(u.count).padEnd(5)}  ${formatUsd(u.totalCost)}`)
    }
  }

  lines.push('')
  lines.push(`Dashboard: ${DASHBOARD_URL}`)
  return lines.join('\n')
}

export default defineCommand({
  meta: {
    name: 'usage',
    description: 'Show credit balance, quota headroom, and per-integration spend',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit the raw usage summary as JSON instead of human output',
      default: false,
    },
  },
  async run({ args }) {
    const token = await ensureToken()
    const summary = await apiFetch<UsageSummary>(API_URL, token, '/api/usage/summary')

    if (args.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
      return
    }
    console.log(renderSummary(summary))
  },
})
