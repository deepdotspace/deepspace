/** Pure cron task validation and schedule evaluation tests. */

import { describe, expect, it } from 'vitest'
import { nextCronFire, parseCronExpression, validateTask } from '../cron-schedule'

describe('parseCronExpression', () => {
  it('parses a simple every-minute expression', () => {
    const parsed = parseCronExpression('* * * * *')
    expect(parsed.minute.size).toBe(60)
    expect(parsed.hour.size).toBe(24)
    expect(parsed.dayOfMonth.size).toBe(31)
    expect(parsed.month.size).toBe(12)
    expect(parsed.dayOfWeek.size).toBe(7)
  })

  it('parses ranges, lists, and step expressions', () => {
    const parsed = parseCronExpression('0 9-17 * * 1-5')
    expect(Array.from(parsed.minute)).toEqual([0])
    expect(Array.from(parsed.hour).sort((a, b) => a - b)).toEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17,
    ])
    expect(Array.from(parsed.dayOfWeek).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('throws on the wrong number of fields', () => {
    expect(() => parseCronExpression('* * * *')).toThrow(/5 fields/)
    expect(() => parseCronExpression('* * * * * *')).toThrow(/5 fields/)
  })

  it('throws on out-of-range literals', () => {
    expect(() => parseCronExpression('60 * * * *')).toThrow(/minute/)
    expect(() => parseCronExpression('* 25 * * *')).toThrow(/hour/)
    expect(() => parseCronExpression('* * 0 * *')).toThrow(/day-of-month/)
  })

  it('throws on non-numeric garbage', () => {
    expect(() => parseCronExpression('foo * * * *')).toThrow()
  })
})

describe('nextCronFire', () => {
  it('finds the next minute boundary that matches', () => {
    const from = new Date('2026-04-28T08:50:00Z')
    const next = nextCronFire('0 9 * * 1-5', 'UTC', from)
    expect(next?.toISOString()).toBe('2026-04-28T09:00:00.000Z')
  })

  it('handles DST spring-forward in America/New_York', () => {
    // On 2026-03-08, 02:00 EST jumps to 03:00 EDT. The next valid 2 AM
    // wall-clock match is therefore the following day at 06:00 UTC.
    const from = new Date('2026-03-08T05:00:00Z')
    const next = nextCronFire('0 2 * * *', 'America/New_York', from)
    expect(next?.toISOString()).toBe('2026-03-09T06:00:00.000Z')
  })
})

describe('validateTask', () => {
  it('accepts a valid interval task', () => {
    expect(() => validateTask({ name: 'heartbeat', intervalMinutes: 1 })).not.toThrow()
  })

  it('accepts a valid cron task', () => {
    expect(() =>
      validateTask({ name: 'daily', schedule: '0 9 * * *', timezone: 'America/New_York' }),
    ).not.toThrow()
  })

  it('rejects ambiguous configs', () => {
    expect(() =>
      validateTask({ name: 'bad', intervalMinutes: 5, schedule: '0 * * * *', timezone: 'UTC' }),
    ).toThrow(/cannot mix/)
  })

  it('rejects a missing schedule or interval', () => {
    expect(() => validateTask({ name: 'empty' })).toThrow(/either intervalMinutes or schedule/)
  })

  it('rejects a schedule without a timezone', () => {
    expect(() => validateTask({ name: 'tz-missing', schedule: '0 9 * * *' })).toThrow()
  })

  it('rejects a malformed expression at validation time', () => {
    expect(() => validateTask({ name: 'bad-cron', schedule: '* * * *', timezone: 'UTC' })).toThrow(
      /5 fields/,
    )
  })

  it('rejects bad task names', () => {
    expect(() => validateTask({ name: 'BadName', intervalMinutes: 1 })).toThrow()
    expect(() => validateTask({ name: 'with space', intervalMinutes: 1 })).toThrow()
  })

  it('rejects out-of-range intervals', () => {
    expect(() => validateTask({ name: 'too-low', intervalMinutes: 0 })).toThrow()
    expect(() => validateTask({ name: 'too-high', intervalMinutes: 99999 })).toThrow()
  })
})
