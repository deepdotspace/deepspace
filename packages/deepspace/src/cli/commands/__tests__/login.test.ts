/**
 * ONB-4: non-interactive login credential precedence.
 * ONB-7: `-e` alias parity for --env across dev/deploy/test.
 */
import { describe, it, expect } from 'vitest'
import { resolveLoginCredentials, loginModeDecision } from '../login'
import dev from '../dev'
import deploy from '../deploy'
import test from '../test'
import init from '../init'

describe('resolveLoginCredentials (ONB-4)', () => {
  it('prefers --password-stdin over --password and $DEEPSPACE_PASSWORD', () => {
    expect(
      resolveLoginCredentials({ passwordArg: 'flag', envPassword: 'env', passwordStdin: 'stdin' }),
    ).toEqual({ email: undefined, password: 'stdin' })
  })

  it('prefers --password over $DEEPSPACE_PASSWORD when no stdin', () => {
    expect(resolveLoginCredentials({ passwordArg: 'flag', envPassword: 'env' }).password).toBe('flag')
  })

  it('falls back to $DEEPSPACE_PASSWORD', () => {
    expect(resolveLoginCredentials({ envPassword: 'env' }).password).toBe('env')
  })

  it('returns an explicitly-empty stdin password as "" (run() then rejects it)', () => {
    expect(
      resolveLoginCredentials({ passwordArg: 'flag', envPassword: 'env', passwordStdin: '' }).password,
    ).toBe('')
  })

  it('email: --email over $DEEPSPACE_EMAIL, else the env', () => {
    expect(resolveLoginCredentials({ emailArg: 'a@x.com', envEmail: 'b@x.com' }).email).toBe('a@x.com')
    expect(resolveLoginCredentials({ envEmail: 'b@x.com' }).email).toBe('b@x.com')
    expect(resolveLoginCredentials({}).email).toBeUndefined()
  })
})

describe('loginModeDecision (ONB-4 — no silent OAuth fall-through)', () => {
  it('password mode when email + non-empty password present', () => {
    expect(loginModeDecision({ email: 'a@x.com', password: 'pw', passwordIntent: true }).mode).toBe('password')
  })
  it('oauth mode when no credentials were supplied at all', () => {
    expect(loginModeDecision({ passwordIntent: false }).mode).toBe('oauth')
  })
  it('ERRORS (not oauth) on an empty --password-stdin — the CI-hang footgun', () => {
    const d = loginModeDecision({ email: 'a@x.com', password: '', passwordIntent: true })
    expect(d.mode).toBe('error')
    expect(d.mode === 'error' && d.message).toMatch(/non-empty password/)
  })
  it('ERRORS when a password was supplied but no email', () => {
    const d = loginModeDecision({ password: 'pw', passwordIntent: true })
    expect(d.mode).toBe('error')
    expect(d.mode === 'error' && d.message).toMatch(/needs an email/)
  })
})

describe('--env has the -e alias everywhere init does (ONB-7)', () => {
  it('init already has -e (baseline)', () => {
    expect((init.args as Record<string, { alias?: string }>).env.alias).toBe('e')
  })
  it('dev/deploy/test now match', () => {
    expect((dev.args as Record<string, { alias?: string }>).env.alias).toBe('e')
    expect((deploy.args as Record<string, { alias?: string }>).env.alias).toBe('e')
    expect((test.args as Record<string, { alias?: string }>).env.alias).toBe('e')
  })
})
