import { describe, expect, it } from 'vitest'
import { formatSignInFailure } from '../storage-state'

describe('formatSignInFailure', () => {
  it('preserves the status and INVALID_ORIGIN code without exposing credentials', () => {
    const message = formatSignInFailure('ada@example.com', {
      status: 403,
      code: 'INVALID_ORIGIN',
      message: 'Origin is not allowed',
    })

    expect(message).toContain('HTTP 403 INVALID_ORIGIN')
    expect(message).toContain('Add this app origin to the auth allowlist')
  })
})
