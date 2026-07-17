/**
 * Unit coverage for the `usage` command's pure rendering helpers. The
 * network flow (auth + fetch) mirrors `apps` and is exercised e2e; here we
 * pin the formatting rules — credit rounding, sub-cent USD, and which
 * bucket rows earn a line.
 */

import { describe, it, expect } from 'vitest'
import { formatCredits, formatUsd, renderSummary, type UsageSummary } from '../usage'

const emptyBucket = { allocation: 0, used: 0, remaining: 0 }

function makeSummary(overrides: {
  credits?: Partial<UsageSummary['credits']>
  usageByIntegration?: UsageSummary['usageByIntegration']
} = {}): UsageSummary {
  return {
    credits: {
      credits: 442.3,
      totalUsed: 57.7,
      totalAllocation: 500,
      subscription: {
        allocation: 500,
        used: 57.7,
        remaining: 442.3,
        tier: 'free',
        renewsAt: '2026-08-01T00:00:00.000Z',
      },
      bonus: { ...emptyBucket, expiresAt: null, expired: false },
      purchased: { ...emptyBucket },
      ...overrides.credits,
    },
    usageByIntegration: overrides.usageByIntegration ?? [
      { name: 'openai', totalCost: 0.43, count: 12 },
    ],
    recentUsage: [],
  }
}

describe('formatCredits', () => {
  it('shows <1 for tiny fractional balances instead of rounding to 0 or 1', () => {
    expect(formatCredits(0.65)).toBe('<1')
  })

  it('keeps one decimal under 10, dropping a trailing .0', () => {
    expect(formatCredits(3.24)).toBe('3.2')
    expect(formatCredits(3)).toBe('3')
    expect(formatCredits(0)).toBe('0')
  })

  it('rounds and adds thousands separators at 10 and above', () => {
    expect(formatCredits(442.3)).toBe('442')
    expect(formatCredits(4250)).toBe('4,250')
  })
})

describe('formatUsd', () => {
  it('uses 2 decimals for a cent or more, and for zero', () => {
    expect(formatUsd(0.43)).toBe('$0.43')
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('uses 4 decimals below a cent so tiny costs stay visible', () => {
    expect(formatUsd(0.0026)).toBe('$0.0026')
  })
})

describe('renderSummary', () => {
  it('shows the plan, renewal date, and total balance', () => {
    const out = renderSummary(makeSummary())
    expect(out).toContain('Plan:     free · renews Aug 1, 2026')
    expect(out).toContain('Credits:  442 of 500 remaining (100 credits = $1)')
  })

  it('omits the renewal fragment when renewsAt is null (calendar-month fallback)', () => {
    const out = renderSummary(
      makeSummary({
        credits: {
          subscription: { allocation: 500, used: 0, remaining: 500, tier: 'free', renewsAt: null },
        },
      }),
    )
    expect(out).toContain('Plan:     free\n')
    expect(out).not.toContain('renews')
  })

  it('hides the bucket breakdown when only the subscription pool is active', () => {
    expect(renderSummary(makeSummary())).not.toContain('Subscription:')
  })

  it('shows the breakdown with expiry when a bonus pool is active', () => {
    const out = renderSummary(
      makeSummary({
        credits: {
          bonus: {
            allocation: 100,
            used: 50,
            remaining: 50,
            expiresAt: '2026-08-15T00:00:00.000Z',
            expired: false,
          },
        },
      }),
    )
    expect(out).toContain('Subscription:  442 of 500 remaining')
    expect(out).toContain('Bonus:         50 of 100 remaining · expires Aug 15, 2026')
    expect(out).not.toContain('Purchased:')
  })

  it('marks an expired bonus instead of showing a stale balance', () => {
    const out = renderSummary(
      makeSummary({
        credits: { bonus: { ...emptyBucket, expiresAt: '2026-06-01T00:00:00.000Z', expired: true } },
      }),
    )
    expect(out).toContain('Bonus:         expired')
  })

  it('shows the purchased row once purchased credits exist', () => {
    const out = renderSummary(
      makeSummary({
        credits: { purchased: { allocation: 200, used: 0, remaining: 200 } },
      }),
    )
    expect(out).toContain('Purchased:     200 of 200 remaining')
  })

  it('renders the per-integration table with USD costs', () => {
    const out = renderSummary(
      makeSummary({
        usageByIntegration: [
          { name: 'openai', totalCost: 0.43, count: 12 },
          { name: 'dataforseo', totalCost: 0.0026, count: 3 },
        ],
      }),
    )
    expect(out).toContain('Usage by integration (last 30 days):')
    expect(out).toMatch(/openai\s+12\s+\$0\.43/)
    expect(out).toMatch(/dataforseo\s+3\s+\$0\.0026/)
  })

  it('shows an empty state when there is no integration usage', () => {
    const out = renderSummary(makeSummary({ usageByIntegration: [] }))
    expect(out).toContain('No integration usage in the last 30 days.')
    expect(out).not.toContain('INTEGRATION')
  })
})
