/**
 * INT-1 (per-token pricing label) and FEAT-13 (paid-invoke confirmation gate).
 */
import { describe, it, expect } from 'vitest'
import { billingUnit, shouldConfirmCost, isInteractive } from '../_invoke-impl'

describe('billingUnit (INT-1)', () => {
  it('renders per_token as "per token", not "per call"', () => {
    expect(billingUnit('per_token')).toBe('per token')
  })
  it('renders per_call as "per call"', () => {
    expect(billingUnit('per_call')).toBe('per call')
  })
  it('renders an unknown per_* model generically', () => {
    expect(billingUnit('per_request')).toBe('per request')
    expect(billingUnit('per_1k_tokens')).toBe('per 1k tokens')
  })
  it('passes a non-per_ model through unchanged', () => {
    expect(billingUnit('flat')).toBe('flat')
  })
})

describe('shouldConfirmCost (FEAT-13)', () => {
  const base = { json: false, yes: false, isTTY: true, baseCost: 0.01 }

  it('confirms a paid call on an interactive terminal', () => {
    expect(shouldConfirmCost(base)).toBe(true)
  })
  it('does not confirm in --json (machine) mode', () => {
    expect(shouldConfirmCost({ ...base, json: true })).toBe(false)
  })
  it('does not confirm when --yes pre-approves', () => {
    expect(shouldConfirmCost({ ...base, yes: true })).toBe(false)
  })
  it('does not confirm on a non-interactive stdin (piped/CI)', () => {
    expect(shouldConfirmCost({ ...base, isTTY: false })).toBe(false)
  })
  it('does not confirm a free endpoint (baseCost 0)', () => {
    expect(shouldConfirmCost({ ...base, baseCost: 0 })).toBe(false)
  })
})

describe('isInteractive (FEAT-13 — both streams must be a TTY)', () => {
  it('is interactive only when stdin AND stdout are TTYs', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true)
  })
  it('is NOT interactive when stdin is piped even if stdout is a terminal', () => {
    // The bug this guards: prompting here would hang forever waiting on stdin.
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false)
  })
  it('is NOT interactive when stdout is redirected', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false)
  })
  it('is NOT interactive when neither is a TTY (CI)', () => {
    expect(isInteractive({}, {})).toBe(false)
  })
})
