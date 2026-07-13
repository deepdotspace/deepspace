/**
 * Unit coverage for the `feedback` command's pure helpers — type validation,
 * payload assembly, and context collection. The full POST flow goes through
 * the api-worker tests; here we cover the part that runs client-side before
 * any network call.
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeType,
  buildFeedbackPayload,
  collectContext,
} from '../feedback'

const ctx = {
  cliVersion: '0.0.0-test',
  nodeVersion: 'v20.0.0',
  platform: 'testos 1.2.3',
}

describe('normalizeType', () => {
  it('defaults to bug when undefined', () => {
    expect(normalizeType(undefined)).toBe('bug')
  })

  it('lowercases and accepts known types', () => {
    expect(normalizeType('FEATURE')).toBe('feature')
    expect(normalizeType('other')).toBe('other')
  })

  it('throws on an unknown type', () => {
    expect(() => normalizeType('nonsense')).toThrow(/Invalid --type/)
  })
})

describe('buildFeedbackPayload', () => {
  it('trims and assembles a valid payload with context', () => {
    const payload = buildFeedbackPayload({
      type: 'feature',
      title: '  Add dark mode  ',
      body: '  please  ',
      context: ctx,
    })
    expect(payload).toMatchObject({
      type: 'feature',
      title: 'Add dark mode',
      body: 'please',
      cliVersion: '0.0.0-test',
      nodeVersion: 'v20.0.0',
      platform: 'testos 1.2.3',
    })
  })

  it('defaults the type to bug', () => {
    expect(buildFeedbackPayload({ type: undefined, title: 'x', body: 'y', context: ctx }).type).toBe('bug')
  })

  it('rejects an empty title or body', () => {
    expect(() => buildFeedbackPayload({ type: 'bug', title: '   ', body: 'y', context: ctx })).toThrow(/title/i)
    expect(() => buildFeedbackPayload({ type: 'bug', title: 'x', body: '  ', context: ctx })).toThrow(/message|description/i)
  })

  it('propagates an invalid type from the payload builder', () => {
    expect(() => buildFeedbackPayload({ type: 'bogus', title: 'x', body: 'y', context: ctx })).toThrow(/Invalid --type/)
  })

  it('rejects an over-length title with a field-specific message', () => {
    expect(() =>
      buildFeedbackPayload({ type: 'bug', title: 'a'.repeat(201), body: 'y', context: ctx }),
    ).toThrow(/Title must be 200/)
  })

  it('rejects an over-length body with a field-specific message', () => {
    expect(() =>
      buildFeedbackPayload({ type: 'bug', title: 'x', body: 'b'.repeat(10_001), context: ctx }),
    ).toThrow(/Description must be 10000/)
  })
})

describe('collectContext', () => {
  it('captures the live runtime context', () => {
    const c = collectContext()
    expect(typeof c.cliVersion).toBe('string')
    expect(c.nodeVersion).toBe(process.version)
    expect(c.platform).toContain(process.platform)
  })

  it('keeps every context field within the server limit', () => {
    const c = collectContext()
    for (const v of [c.cliVersion, c.nodeVersion, c.platform, c.appName]) {
      if (v != null) expect(v.length).toBeLessThanOrEqual(200)
    }
  })
})
