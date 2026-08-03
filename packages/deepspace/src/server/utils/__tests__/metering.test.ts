import { describe, expect, it, vi } from 'vitest'
import { meterUsage } from '../metering'

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
