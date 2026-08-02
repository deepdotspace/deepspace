import { describe, expect, it } from 'vitest'
import { pickPreviousRelease, unavailableDoGuardRefusal } from '../rollback'

describe('pickPreviousRelease (default rollback target)', () => {
  // Regression: the two default-rollback rejections must carry stable machine
  // `code`s parallel to the explicit-id `not_found` path, so release automation
  // can distinguish empty history from a single-release repo without scraping.
  it('empty history → no_releases code', () => {
    expect(pickPreviousRelease([])).toEqual({
      error: expect.stringContaining('No releases recorded yet'),
      code: 'no_releases',
    })
  })

  it('exactly one release → no_previous_release code', () => {
    expect(pickPreviousRelease([{ id: 'rel_1' }])).toEqual({
      error: expect.stringContaining('Only one release exists'),
      code: 'no_previous_release',
    })
  })

  it('two+ releases → the previous release id, no error', () => {
    expect(pickPreviousRelease([{ id: 'rel_current' }, { id: 'rel_prev' }])).toEqual({
      releaseId: 'rel_prev',
    })
  })
})

describe('unavailableDoGuardRefusal', () => {
  it('does not turn a judgment-dependent outage into a mandatory retry loop', () => {
    const refusal = unavailableDoGuardRefusal('Could not verify live classes.')

    expect(refusal).toMatchObject({
      code: 'do_guard_unavailable',
      action: undefined,
      actionRequired: false,
    })
    expect(refusal.message).toContain('--allow-do-deletion')
  })
})
