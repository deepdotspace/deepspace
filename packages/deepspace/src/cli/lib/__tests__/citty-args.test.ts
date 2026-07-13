/**
 * SEC-3 regression coverage. The `secrets delete`/`set` breakage was caused by
 * citty duplicating the bound positional into `args._`; dedupePositionals is the
 * shared fix. These tests would fail if the dedupe were dropped.
 */
import { describe, it, expect } from 'vitest'
import { dedupePositionals } from '../citty-args'

describe('dedupePositionals', () => {
  it('collapses the citty-duplicated single positional to one (SEC-3)', () => {
    // `secrets delete A` → citty gives args.key='A', args._=['A'].
    // Without dedupe this yields ['A','A'] → delete A twice → 404 → exit 1.
    expect(dedupePositionals('A', ['A'])).toEqual(['A'])
  })

  it('keeps distinct positionals once, in first-seen order (SEC-3)', () => {
    // `secrets delete A B` → args.key='A', args._=['A','B'].
    expect(dedupePositionals('A', ['A', 'B'])).toEqual(['A', 'B'])
    expect(dedupePositionals('A', ['A', 'B', 'C'])).toEqual(['A', 'B', 'C'])
  })

  it('unions when the bound value is not already in the rest', () => {
    expect(dedupePositionals('X', ['A', 'B'])).toEqual(['X', 'A', 'B'])
  })

  it('drops empty strings and non-string entries', () => {
    expect(dedupePositionals('A', ['A', '', 5, null, undefined, 'B'])).toEqual(['A', 'B'])
  })

  it('tolerates a missing or non-array rest', () => {
    expect(dedupePositionals('A', undefined)).toEqual(['A'])
    expect(dedupePositionals('A', null)).toEqual(['A'])
    expect(dedupePositionals(undefined, ['A', 'B'])).toEqual(['A', 'B'])
  })
})
