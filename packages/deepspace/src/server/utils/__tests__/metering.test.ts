// Unit tests for `priceBindingUsageEvent` — the (kind, op, units) → USD
// mapping that every binding-settlement charge flows through. Lives in the
// SDK because the rates are part of the schema the meter helpers write.
//
// Pins the per-row rate so a future contributor can't silently swap rate
// constants, flip a branch, or accidentally price ai/output at non-zero
// (which would silently under-bill chat-LLM use — see the
// priceBindingUsageEvent docstring for the deliberate $0 contract).

import { describe, it, expect } from 'vitest'
import { priceBindingUsageEvent, COST_RATES } from '../metering'

describe('priceBindingUsageEvent', () => {
  it('prices ai/input at the embedding-input per-char rate', () => {
    expect(priceBindingUsageEvent('ai', 'input', 1000)).toBeCloseTo(
      1000 * COST_RATES.ai.embedInputPerChar,
      12,
    )
  })

  it('returns 0 for ai/output (per-model LLM rates not wired yet)', () => {
    expect(priceBindingUsageEvent('ai', 'output', 1000)).toBe(0)
  })

  it('returns 0 for ai/call (no token data → no charge, observability only)', () => {
    expect(priceBindingUsageEvent('ai', 'call', 1000)).toBe(0)
  })

  it('prices vectorize/query at queriedPerDim', () => {
    // 10 vectors × 384 dims = 3840 queried dims (CF's additive formula).
    expect(priceBindingUsageEvent('vectorize', 'query', 3840)).toBeCloseTo(
      3840 * COST_RATES.vectorize.queriedPerDim,
      12,
    )
  })

  it('returns 0 for vectorize ops other than query', () => {
    // upsert/delete/getByIds are recorded for observability but not priced
    // per-event (storage delta is a separate monthly snapshot).
    expect(priceBindingUsageEvent('vectorize', 'upsert', 1000)).toBe(0)
    expect(priceBindingUsageEvent('vectorize', 'delete', 1000)).toBe(0)
    expect(priceBindingUsageEvent('vectorize', 'getByIds', 1000)).toBe(0)
  })

  it('returns 0 for unknown kinds', () => {
    expect(priceBindingUsageEvent('custom-thing', 'op', 1000)).toBe(0)
    expect(priceBindingUsageEvent('', '', 1000)).toBe(0)
  })

  it('returns 0 for zero units on a priced (kind, op)', () => {
    expect(priceBindingUsageEvent('ai', 'input', 0)).toBe(0)
    expect(priceBindingUsageEvent('vectorize', 'query', 0)).toBe(0)
  })
})
