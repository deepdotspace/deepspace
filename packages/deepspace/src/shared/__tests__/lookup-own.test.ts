import { describe, expect, it } from 'vitest'
import { lookupOwn, SAFE_PATH_SEGMENT } from '../lookup-own'

describe('lookupOwn', () => {
  const handlers: Record<string, () => string> = { run: () => 'ran' }

  it('returns own entries', () => {
    expect(lookupOwn(handlers, 'run')?.()).toBe('ran')
  })

  it('does not resolve inherited properties', () => {
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
      expect(lookupOwn(handlers, name)).toBeUndefined()
    }
  })

  it('returns undefined for missing names', () => {
    expect(lookupOwn(handlers, 'missing')).toBeUndefined()
  })
})

describe('SAFE_PATH_SEGMENT', () => {
  it('accepts plain identifiers', () => {
    for (const name of ['fal', 'openai', 'get-model', 'list_models', 'A1']) {
      expect(SAFE_PATH_SEGMENT.test(name)).toBe(true)
    }
  })

  it('refuses traversal and separators', () => {
    for (const name of [
      '..',
      '../users',
      'a/b',
      'a\\b',
      'a%2Fb',
      '.hidden',
      '-lead',
      '',
      'a'.repeat(65),
    ]) {
      expect(SAFE_PATH_SEGMENT.test(name)).toBe(false)
    }
  })
})
