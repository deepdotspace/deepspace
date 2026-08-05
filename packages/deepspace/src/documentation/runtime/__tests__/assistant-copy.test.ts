import { describe, expect, it } from 'vitest'
import { documentationSubject } from '../../text'

describe('documentation assistant copy', () => {
  it('avoids duplicating documentation terminology', () => {
    expect(documentationSubject('Documentation')).toBe('documentation')
    expect(documentationSubject('DeepSpace Docs')).toBe('DeepSpace Docs')
    expect(documentationSubject('API Documentation')).toBe('API Documentation')
    expect(documentationSubject('DeepSpace')).toBe('DeepSpace documentation')
  })
})
