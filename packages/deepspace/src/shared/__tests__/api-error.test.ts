import { describe, expect, it } from 'vitest'
import { normalizeApiError } from '../api-error'

describe('normalizeApiError', () => {
  it('integrations convention: { error: slug, message: human, extras } → human error, slug code, extras in details', () => {
    expect(
      normalizeApiError(402, {
        error: 'insufficient_credits',
        message: 'Insufficient credits.',
        availableCredits: 12,
        requiredCredits: 40,
      }),
    ).toEqual({
      error: 'Insufficient credits.',
      code: 'insufficient_credits',
      status: 402,
      details: { availableCredits: 12, requiredCredits: 40 },
    })
  })

  it('collaborators convention: { code: slug, error: human } — the specific sentence beats the generic map', () => {
    const normalized = normalizeApiError(402, {
      code: 'insufficient_credits',
      error: 'Out of credits — top up your account to invite new collaborators by email.',
    })

    expect(normalized).toEqual({
      error: 'Out of credits — top up your account to invite new collaborators by email.',
      code: 'insufficient_credits',
      status: 402,
    })
    // No redundant details.code echoing the slug.
    expect(normalized.details).toBeUndefined()
  })

  it('bare mapped slug → humanized text, slug preserved as code', () => {
    expect(normalizeApiError(404, { error: 'unknown_plan' })).toEqual({
      error: 'Unknown subscription plan.',
      code: 'unknown_plan',
      status: 404,
    })
  })

  it('bare unmapped slug → falls back to the raw slug as text, still branchable as code', () => {
    expect(normalizeApiError(409, { error: 'owner_zorp_not_calibrated' })).toEqual({
      error: 'owner_zorp_not_calibrated',
      code: 'owner_zorp_not_calibrated',
      status: 409,
    })
  })

  it('transport failure (status 0, no body) → generic text, no code', () => {
    expect(normalizeApiError(0, null)).toEqual({
      error: 'Request failed (0)',
      status: 0,
    })
  })

  it('details excludes the envelope keys (success/error/message/issues/code) and keeps the rest', () => {
    const normalized = normalizeApiError(400, {
      success: false,
      error: 'validation_failed',
      message: 'Validation failed.',
      code: 'validation_failed',
      issues: [{ path: ['messages'], message: 'Required' }],
      hint: 'messages is required',
    })

    expect(normalized.details).toEqual({ hint: 'messages is required' })
    expect(normalized.issues).toEqual([{ path: ['messages'], message: 'Required' }])
  })
})
