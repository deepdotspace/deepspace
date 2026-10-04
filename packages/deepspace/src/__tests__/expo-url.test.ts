import { describe, expect, it } from 'vitest'
import {
  buildExpoOAuthStartUrl,
  codeFromExpoRedirect,
  normalizeExpoBaseUrl,
  stateFromExpoRedirect,
} from '../expo-url'

describe('Expo auth URL helpers', () => {
  it('builds a same-origin native start URL with an encoded callback', () => {
    const value = buildExpoOAuthStartUrl('https://example.app.space/', 'google', 'myapp://auth/callback', 'state-1')
    const url = new URL(value)
    expect(url.pathname).toBe('/api/auth/native-start')
    expect(url.searchParams.get('provider')).toBe('google')
    expect(url.searchParams.get('redirect_uri')).toBe('myapp://auth/callback')
    expect(url.searchParams.get('state')).toBe('state-1')
  })

  it('extracts only the one-time code from a callback', () => {
    expect(codeFromExpoRedirect('myapp://auth/callback?code=one-time')).toBe('one-time')
    expect(codeFromExpoRedirect('not a url')).toBeNull()
    expect(stateFromExpoRedirect('myapp://auth/callback?code=one-time&state=state-1')).toBe('state-1')
  })

  it('normalizes trailing slashes', () => { expect(normalizeExpoBaseUrl('https://example.app.space///')).toBe('https://example.app.space') })

  it('supports an app-specific start route', () => {
    const value = buildExpoOAuthStartUrl('https://example.app.space', 'google', 'myapp://auth/callback', undefined, '/auth/start', 'challenge')
    const url = new URL(value)
    expect(url.pathname).toBe('/auth/start')
    expect(url.searchParams.get('code_challenge')).toBe('challenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })
})
