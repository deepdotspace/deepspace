import { describe, expect, it } from 'vitest'
import {
  agentCredentialFromEntropy,
  normalizeAgentCredential,
  agentCredentialBearer,
} from '../agent-credential'

describe('portable account phrase', () => {
  it('uses twelve independent full 11-bit selections without a checksum', () => {
    const all = new Set<string>()
    for (let index = 0; index < 2048; index++) {
      const bytes = new Uint8Array(24)
      for (let j = 0; j < 12; j++) {
        bytes[j * 2] = index >> 8
        bytes[j * 2 + 1] = index & 255
      }
      const phrase = agentCredentialFromEntropy(bytes)
      const words = phrase.split(' ')
      expect(words).toHaveLength(12)
      expect(new Set(words).size).toBe(1)
      expect(normalizeAgentCredential(phrase)).toBe(phrase)
      all.add(words[0])
    }
    expect(all.size).toBe(2048)
    expect(() => agentCredentialFromEntropy(new Uint8Array(23))).toThrow()
  })
  it('normalizes transport and chat whitespace, without guessing missing words or typos', () => {
    const phrase =
      'abandon ability able about above absent absorb abstract absurd abuse access accident'
    expect(
      normalizeAgentCredential('  ' + phrase.toUpperCase().replaceAll(' ', ' \n\t ') + ' '),
    ).toBe(phrase)
    expect(normalizeAgentCredential(agentCredentialBearer(phrase))).toBe(phrase)
    expect(normalizeAgentCredential(phrase.replace('accident', 'accidnt'))).toBeNull()
    expect(normalizeAgentCredential(phrase.split(' ').slice(1).join(' '))).toBeNull()
    expect(normalizeAgentCredential(phrase + ' zoo')).toBeNull()
    expect(normalizeAgentCredential({})).toBeNull()
    const legacy = 'dsa_' + 'Ab'.repeat(21) + 'Z'
    expect(normalizeAgentCredential(legacy)).toBe(legacy)
    expect(agentCredentialBearer(legacy)).toBe(legacy)
  })
})
