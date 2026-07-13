import { describe, expect, it } from 'vitest'
import { decodeJwtPayload } from '../jwt'

describe('decodeJwtPayload', () => {
  it('decodes base64url payloads that standard atob rejects', () => {
    const token = [
      'header',
      'eyJzdWIiOiJ1IiwibmFtZSI6IsK-IiwiZXhwIjoyMDAwMDAwMDAwfQ',
      'signature',
    ].join('.')

    expect(() => atob(token.split('.')[1])).toThrow()
    expect(decodeJwtPayload<{ sub: string; name: string; exp: number }>(token)).toEqual({
      sub: 'u',
      name: '\u00be',
      exp: 2000000000,
    })
  })

  it('rejects tokens without a payload segment', () => {
    expect(() => decodeJwtPayload('header')).toThrow('JWT payload is missing')
  })
})
