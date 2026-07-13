import { describe, it, expect } from 'vitest'
import { validateAppName, resolveAppName } from '../app-name'

describe('validateAppName', () => {
  const valid = [
    'my-app',
    'unison-search',
    'a1',
    'search-v2',
    'x'.repeat(63),
    'app-with-many-words-123',
  ]
  for (const n of valid) {
    it(`accepts: ${n}`, () => {
      const r = validateAppName(n)
      expect(r.valid).toBe(true)
      if (r.valid) expect(r.name).toBe(n)
    })
  }

  const invalid: Array<[string, RegExp]> = [
    ['My_App', /lowercase|invalid/i], // capital + underscore
    ['my_app', /invalid/i], // underscore
    ['MyApp', /invalid/i], // capital
    ['app--double', /invalid/i], // consecutive dashes
    ['-leading', /invalid/i],
    ['trailing-', /invalid/i],
    ['a', /too short/i],
    ['x'.repeat(64), /too long/i],
    ['', /required/i],
    ['   ', /required/i],
    ['has space', /invalid/i],
    ['has.dot', /invalid/i],
    ['has/slash', /invalid/i],
  ]
  for (const [n, expected] of invalid) {
    it(`rejects: ${JSON.stringify(n)}`, () => {
      const r = validateAppName(n)
      expect(r.valid).toBe(false)
      if (!r.valid) expect(r.reason).toMatch(expected)
    })
  }

  it('rejects non-string inputs', () => {
    for (const v of [null, undefined, 42, true, {}, []]) {
      const r = validateAppName(v)
      expect(r.valid).toBe(false)
      if (!r.valid) expect(r.reason).toMatch(/must be a string/i)
    }
  })

  it('trims whitespace before validating', () => {
    const r = validateAppName('  my-app  ')
    expect(r.valid).toBe(true)
    if (r.valid) expect(r.name).toBe('my-app')
  })
})

describe('resolveAppName — preserves historical "still deploys" behavior', () => {
  it('passes valid names through unchanged with no warning', () => {
    const r = resolveAppName('my-app')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe('my-app')
      expect(r.warning).toBeUndefined()
    }
  })

  it('sanitizes "My_App" → "my-app" with a warning', () => {
    const r = resolveAppName('My_App')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe('my-app')
      expect(r.warning).toMatch(/My_App.*my-app/)
    }
  })

  it('sanitizes "ABC123" → "abc123" with a warning', () => {
    const r = resolveAppName('ABC123')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe('abc123')
      expect(r.warning).toBeDefined()
    }
  })

  it('collapses consecutive dashes from sanitization', () => {
    const r = resolveAppName('my!!!app')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toBe('my-app')
  })

  it('strips leading/trailing dashes', () => {
    const r = resolveAppName('!my-app!')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toBe('my-app')
  })

  it('rejects only when even sanitization yields nothing valid', () => {
    for (const bad of ['', '   ', '!@#$%', '-']) {
      const r = resolveAppName(bad)
      expect(r.ok, `expected reject for ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('rejects names that are still too long after sanitization', () => {
    // 70 valid alphanumerics — sanitize is a no-op, but `validateAppName`
    // rejects with maxLength. Verifies the post-sanitize re-validation runs.
    const r = resolveAppName('a'.repeat(70))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/too long|max/i)
  })

  it('rejects when sanitization produces a result that fails maxLength', () => {
    // 200-char input mixing alphanumerics and dots → dots become hyphens,
    // stays well above 63 chars after collapse.
    const r = resolveAppName('x'.repeat(100) + '.'.repeat(100))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/too long|sanitized/i)
  })

  it('rejects non-string inputs', () => {
    for (const v of [null, undefined, 42, true]) {
      const r = resolveAppName(v)
      expect(r.ok).toBe(false)
    }
  })
})
