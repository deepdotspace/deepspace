/**
 * SEC-3 regression coverage. The `secrets delete`/`set` breakage was caused by
 * citty duplicating the bound positional into `args._`; dedupePositionals is the
 * shared fix. These tests would fail if the dedupe were dropped.
 */
import { describe, it, expect } from 'vitest'
import { dedupePositionals, parseLimitArg, parseCursorArg } from '../citty-args'

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

describe('parseLimitArg', () => {
  // Live-test finding: `Number(args.limit) || undefined` (and `args.limit ?
  // Number(args.limit) : undefined`) turned an INVALID --limit into "no limit"
  // — an unbounded page — instead of an error. A caller asking for a small page
  // could get the whole list back with no signal.
  it('treats an absent flag as "no limit" (server default)', () => {
    expect(parseLimitArg(undefined)).toEqual({})
    expect(parseLimitArg('')).toEqual({})
    expect(parseLimitArg(null)).toEqual({})
  })

  it('passes a positive integer through', () => {
    expect(parseLimitArg('50')).toEqual({ limit: 50 })
    expect(parseLimitArg('1')).toEqual({ limit: 1 })
  })

  it('rejects zero (incl. leading-zero spellings) instead of silently making the page unbounded', () => {
    for (const zero of ['0', '00', '000']) {
      const r = parseLimitArg(zero)
      expect(r.limit, zero).toBeUndefined()
      expect(r.error, zero).toMatch(/positive integer/)
    }
  })

  it('rejects negatives, fractionals, non-numerics, and whitespace-only', () => {
    for (const bad of ['-5', '2.5', 'nope', 'NaN', 'Infinity', ' ', '\t', '   ']) {
      expect(parseLimitArg(bad).error, bad).toBeTruthy()
      expect(parseLimitArg(bad).limit, bad).toBeUndefined()
    }
  })

  it('rejects hex/binary/scientific/float spellings the server never emits', () => {
    // Number() would accept all of these as integers; the digit-string contract
    // rejects them so `--limit` means a plain base-10 count and nothing else.
    for (const bad of ['0x10', '0b10', '0o17', '1e3', '5.0', '+5', '1_000']) {
      expect(parseLimitArg(bad).error, bad).toBeTruthy()
      expect(parseLimitArg(bad).limit, bad).toBeUndefined()
    }
  })

  it('tolerates surrounding whitespace around a valid count', () => {
    expect(parseLimitArg('  5  ')).toEqual({ limit: 5 })
  })

  it('rejects values past the safe-integer range (2^53) that would round when parsed', () => {
    expect(parseLimitArg('9007199254740992').error).toBeTruthy() // exactly 2^53 — first UNsafe integer
    expect(parseLimitArg('9007199254740993').error).toBeTruthy() // 2^53 + 1 → rounds to 2^53
    expect(parseLimitArg('99999999999999999999').error).toBeTruthy()
    // the exact boundary (MAX_SAFE_INTEGER = 2^53 - 1) is representable, so it is accepted
    expect(parseLimitArg(String(Number.MAX_SAFE_INTEGER))).toEqual({ limit: Number.MAX_SAFE_INTEGER })
  })

  it('names the offending value in the error', () => {
    expect(parseLimitArg('nope').error).toContain('nope')
  })
})

describe('parseCursorArg', () => {
  // Live-test finding: `activity --since 1.9` was floored to 1 and REPLAYED an
  // earlier page. A cursor is only ever a non-negative integer the server
  // returned, so a fractional or otherwise malformed value must fail.
  it('treats an absent flag as cursor 0 (start of history)', () => {
    expect(parseCursorArg(undefined)).toEqual({ cursor: 0 })
    expect(parseCursorArg('')).toEqual({ cursor: 0 })
    expect(parseCursorArg(null)).toEqual({ cursor: 0 })
  })

  it('passes a non-negative integer through (0 is a valid cursor)', () => {
    expect(parseCursorArg('0')).toEqual({ cursor: 0 })
    expect(parseCursorArg('42')).toEqual({ cursor: 42 })
  })

  it('rejects a fractional cursor rather than flooring it to an earlier page', () => {
    const r = parseCursorArg('1.9')
    expect(r.cursor).toBe(0)
    expect(r.error).toMatch(/integer cursor/)
  })

  it('rejects whitespace-only rather than coercing it to 0 and replaying history', () => {
    // Number("  ") === 0, so without the digit-string check a corrupted cursor
    // truncated to whitespace would silently replay from the start of history.
    for (const bad of [' ', '\t', '   ']) {
      expect(parseCursorArg(bad).error, bad).toBeTruthy()
      expect(parseCursorArg(bad).cursor, bad).toBe(0)
    }
  })

  it('rejects negatives, non-numerics, and hex/scientific spellings', () => {
    for (const bad of ['-1', 'nope', 'NaN', 'Infinity', '0x10', '2e1', '3.0']) {
      expect(parseCursorArg(bad).error, bad).toBeTruthy()
    }
  })

  it('tolerates surrounding whitespace around a valid cursor', () => {
    expect(parseCursorArg('  42  ')).toEqual({ cursor: 42 })
  })

  it('rejects a cursor past the safe-integer range rather than echoing back a rounded value', () => {
    expect(parseCursorArg('9007199254740992').error).toBeTruthy() // exactly 2^53 — first UNsafe integer
    expect(parseCursorArg('9007199254740993').error).toBeTruthy() // 2^53 + 1 → rounds to 2^53
    expect(parseCursorArg('99999999999999999999').error).toBeTruthy()
    // the exact boundary (MAX_SAFE_INTEGER = 2^53 - 1) is representable, so it is accepted
    expect(parseCursorArg(String(Number.MAX_SAFE_INTEGER))).toEqual({ cursor: Number.MAX_SAFE_INTEGER })
  })
})
