import { describe, expect, it } from 'vitest'
import { APP_LOG_EVENT_KEYS, LOG_LEVELS } from '../log-events'

describe('log-events shared contract', () => {
  it('enumerates exactly the whitelisted event keys, including source', () => {
    // The e2e whitelist mirrors this set; `source` is the field whose earlier
    // omission let client-forwarded events fail the whitelist assertion. A
    // compile-time guard in the module keeps this tuple ≡ keyof AppLogEvent.
    expect([...APP_LOG_EVENT_KEYS].sort()).toEqual(
      ['exception', 'eventType', 'id', 'level', 'message', 'outcome', 'request', 'source', 'timestamp'].sort(),
    )
  })

  it('exposes the canonical level set', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'log', 'info', 'warn', 'error'])
  })
})
