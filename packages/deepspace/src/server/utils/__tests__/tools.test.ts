/**
 * Tests for `applyAiToolDefaults` — the assistant-only parameter defaults
 * applied by the AI tool layer (`buildTools`) before a model tool call is
 * dispatched. The matching guarantee that the shared tools dispatch stays
 * unbounded lives in `handlers/__tests__/tools-api.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { applyAiToolDefaults, DEFAULT_QUERY_LIMIT } from '../tools'

describe('applyAiToolDefaults', () => {
  it('defaults the records.query page size when the model omits `limit`', () => {
    expect(applyAiToolDefaults('records.query', { collection: 'companies' })).toEqual({
      collection: 'companies',
      limit: DEFAULT_QUERY_LIMIT,
    })
  })

  it('honors an explicit records.query `limit`', () => {
    expect(applyAiToolDefaults('records.query', { collection: 'companies', limit: 5 })).toEqual({
      collection: 'companies',
      limit: 5,
    })
  })

  it('leaves an explicit `limit: 0` untouched (does not override a deliberate value)', () => {
    expect(applyAiToolDefaults('records.query', { collection: 'companies', limit: 0 })).toEqual({
      collection: 'companies',
      limit: 0,
    })
  })

  it('does not default other tools', () => {
    expect(applyAiToolDefaults('records.get', { collection: 'companies', recordId: 'co1' })).toEqual({
      collection: 'companies',
      recordId: 'co1',
    })
  })

  it('does not mutate the input params', () => {
    const input = { collection: 'companies' }
    applyAiToolDefaults('records.query', input)
    expect(input).toEqual({ collection: 'companies' })
  })
})
