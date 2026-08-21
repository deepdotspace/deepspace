import { describe, expect, it, vi } from 'vitest'
import { COST_RATES, meterUsage, priceBindingUsageEvent } from '../metering'

describe('meterUsage app attribution', () => {
  it('uses the permanent resource id across a public identity migration', () => {
    const writeDataPoint = vi.fn()
    const ok = meterUsage(
      {
        USAGE_EVENTS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
        OWNER_USER_ID: 'owner-1',
        APP_NAME: 'current-display-name',
        DEEPSPACE_RESOURCE_ID: 'legacy-physical-app',
      },
      'ai',
      { id: 'model', op: 'input', units: 10, count: 1 },
    )

    expect(ok).toBe(true)
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['owner-1'],
      blobs: ['legacy-physical-app', 'ai', 'model', 'input'],
      doubles: [10, 1],
    })
  })

  it('retains APP_NAME as a compatibility fallback for local or older runtimes', () => {
    const writeDataPoint = vi.fn()
    meterUsage(
      {
        USAGE_EVENTS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
        APP_NAME: 'legacy-app',
      },
      'custom',
    )
    expect(writeDataPoint.mock.calls[0][0].blobs[0]).toBe('legacy-app')
  })
})

describe('managed AI Search preview pricing', () => {
  it('publishes every approved raw rate through the shared binding pricer', () => {
    expect(COST_RATES.aiSearch).toEqual({
      ingestPerToken: 0.75 / 1_000_000,
      ingestImagePerToken: 0.5 / 1_000_000,
      storagePerByteMonth: 2 / 1_000_000_000,
      hybridOrSemanticPerQuery: 0.75 / 1_000,
      fulltextPerQuery: 0.1 / 1_000,
    })
    expect(priceBindingUsageEvent('ai_search', 'ingest', 1_000_000)).toBeCloseTo(0.75)
    expect(priceBindingUsageEvent('ai_search', 'ingest-image', 1_000_000)).toBeCloseTo(0.5)
    expect(priceBindingUsageEvent('ai_search', 'storage', 1_000_000_000)).toBeCloseTo(2)
    expect(priceBindingUsageEvent('ai_search', 'search-hybrid', 1_000)).toBeCloseTo(0.75)
    expect(priceBindingUsageEvent('ai_search', 'search-semantic', 1_000)).toBeCloseTo(0.75)
    expect(priceBindingUsageEvent('ai_search', 'search-fulltext', 1_000)).toBeCloseTo(0.1)
  })

  it('prices a corrupt unit count at zero rather than letting NaN reach a cost', () => {
    for (const kind of ['ai_search', 'ai', 'vectorize']) {
      const op = kind === 'ai_search' ? 'ingest' : kind === 'ai' ? 'input' : 'query'
      expect(priceBindingUsageEvent(kind, op, Number.NaN)).toBe(0)
      expect(priceBindingUsageEvent(kind, op, Number.POSITIVE_INFINITY)).toBe(0)
      expect(priceBindingUsageEvent(kind, op, -1)).toBe(0)
    }
  })
})
