import { describe, expect, it } from 'vitest'
import {
  CLIENT_ERROR_CAPS,
  CLIENT_LOG_MARKER,
  clientErrorToLogLine,
  normalizeClientErrorReport,
} from '../client-errors'

describe('normalizeClientErrorReport', () => {
  it('keeps a well-formed report and defaults an unknown kind to error', () => {
    expect(
      normalizeClientErrorReport({
        kind: 'weird',
        name: 'TypeError',
        message: 'boom',
        stack: 'TypeError: boom\n  at x',
        url: 'https://app.test/page',
        line: 3,
        col: 9,
      }),
    ).toEqual({
      kind: 'error',
      name: 'TypeError',
      message: 'boom',
      stack: 'TypeError: boom\n  at x',
      url: 'https://app.test/page',
      line: 3,
      col: 9,
    })
  })

  it('preserves the known kinds', () => {
    expect(normalizeClientErrorReport({ kind: 'react', message: 'm' })?.kind).toBe('react')
    expect(normalizeClientErrorReport({ kind: 'unhandledrejection', message: 'm' })?.kind).toBe(
      'unhandledrejection',
    )
  })

  it('caps oversized fields', () => {
    const big = 'x'.repeat(20_000)
    const r = normalizeClientErrorReport({ message: big, stack: big, name: big, url: big })
    expect(r?.message.length).toBe(CLIENT_ERROR_CAPS.message)
    expect(r?.stack?.length).toBe(CLIENT_ERROR_CAPS.stack)
    expect(r?.name?.length).toBe(CLIENT_ERROR_CAPS.name)
    expect(r?.url?.length).toBe(CLIENT_ERROR_CAPS.url)
  })

  it('falls back to the name when there is a stack but no message', () => {
    const r = normalizeClientErrorReport({ name: 'Error', stack: '  at y' })
    expect(r).toEqual({ kind: 'error', name: 'Error', message: 'Error', stack: '  at y' })
  })

  it('drops junk, non-objects, and empty reports', () => {
    expect(normalizeClientErrorReport(null)).toBeNull()
    expect(normalizeClientErrorReport('nope')).toBeNull()
    expect(normalizeClientErrorReport({})).toBeNull()
    expect(normalizeClientErrorReport({ message: '', stack: '' })).toBeNull()
    // Non-finite / wrong-typed numeric fields are dropped, not coerced.
    const r = normalizeClientErrorReport({ message: 'm', line: 'NaN', col: Infinity })
    expect(r).toEqual({ kind: 'error', message: 'm' })
  })
})

describe('clientErrorToLogLine', () => {
  it('is a single marker-prefixed JSON line that round-trips', () => {
    const big = 'x'.repeat(20_000)
    const report = normalizeClientErrorReport({ name: 'E', message: big, stack: big })!
    const line = clientErrorToLogLine(report)
    expect(line.startsWith(CLIENT_LOG_MARKER + ' ')).toBe(true)
    // Real newlines are JSON-escaped, so the line stays single-line.
    expect(line).not.toContain('\n')
    expect(JSON.parse(line.slice(CLIENT_LOG_MARKER.length).trim())).toEqual(report)
  })

  it('stays well under the 256 KB CF event cap even for escaped/multibyte input', () => {
    // JSON escaping (a control char → \u00XX, 6×) and multibyte inflate the
    // serialized bytes far past the char caps — but must stay under Cloudflare
    // Workers Logs' ~256 KB per-event truncation point so the line survives and
    // re-parses on read. (Char length is NOT the invariant; serialized bytes are.)
    const ctrl = String.fromCharCode(1)
    const controls = normalizeClientErrorReport({ message: ctrl.repeat(1024), stack: ctrl.repeat(4096) })!
    const cjk = normalizeClientErrorReport({ message: '错'.repeat(1024), stack: '错'.repeat(4096) })!
    for (const report of [controls, cjk]) {
      const line = clientErrorToLogLine(report)
      expect(new TextEncoder().encode(line).length).toBeLessThan(256 * 1024)
      expect(JSON.parse(line.slice(CLIENT_LOG_MARKER.length).trim())).toEqual(report)
    }
  })
})
