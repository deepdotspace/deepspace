import { describe, it, expect } from 'vitest'
import { extractCustomDevVars, parseDevVars, stripGeneratedSecretsCache } from '../env'
import { renderSecretsCache } from '../lib/secrets'

describe('extractCustomDevVars', () => {
  it('returns empty string for empty input', () => {
    expect(extractCustomDevVars('')).toBe('')
  })

  it('strips an SDK-managed key', () => {
    const input = 'AUTH_JWT_ISSUER=https://example.com\n'
    expect(extractCustomDevVars(input)).toBe('')
  })

  it('preserves a user-defined key', () => {
    const input = 'MY_TOKEN=secret123\n'
    expect(extractCustomDevVars(input)).toBe('MY_TOKEN=secret123')
  })

  it('strips SDK keys but keeps user keys', () => {
    const input = [
      'AUTH_JWT_ISSUER=https://example.com',
      'AUTH_WORKER_URL=https://example.com',
      'MY_TOKEN=secret123',
      'OWNER_USER_ID=u_abc',
      'STRIPE_KEY=sk_test_xyz',
      '',
    ].join('\n')
    expect(extractCustomDevVars(input)).toBe('MY_TOKEN=secret123\nSTRIPE_KEY=sk_test_xyz')
  })

  it('preserves comments and blank lines verbatim', () => {
    const input = [
      '# my custom section',
      '',
      'STRIPE_KEY=sk_test_xyz',
      '# trailing comment',
      'OWNER_USER_ID=u_abc',
    ].join('\n')
    expect(extractCustomDevVars(input)).toBe(
      ['# my custom section', '', 'STRIPE_KEY=sk_test_xyz', '# trailing comment'].join('\n'),
    )
  })

  it('strips a multi-line quoted SDK value (PEM key)', () => {
    const input = [
      'AUTH_JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----',
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA',
      '-----END PUBLIC KEY-----"',
      'STRIPE_KEY=sk_test_xyz',
    ].join('\n')
    expect(extractCustomDevVars(input)).toBe('STRIPE_KEY=sk_test_xyz')
  })

  it('preserves a user multi-line quoted value', () => {
    const input = [
      'AUTH_WORKER_URL=https://x.example.com',
      'MY_PEM="-----BEGIN PRIVATE KEY-----',
      'AAAA',
      '-----END PRIVATE KEY-----"',
      'OTHER=value',
    ].join('\n')
    expect(extractCustomDevVars(input)).toBe(
      [
        'MY_PEM="-----BEGIN PRIVATE KEY-----',
        'AAAA',
        '-----END PRIVATE KEY-----"',
        'OTHER=value',
      ].join('\n'),
    )
  })

  it('handles escaped quotes inside a quoted value', () => {
    const input = ['AUTH_WORKER_URL=x', 'MY_VAR="he said \\"hi\\" today"', 'KEEP=this'].join('\n')
    expect(extractCustomDevVars(input)).toBe('MY_VAR="he said \\"hi\\" today"\nKEEP=this')
  })

  it('drops trailing blank lines accumulated across runs', () => {
    const input = ['MY_VAR=value', '', '', '', ''].join('\n')
    expect(extractCustomDevVars(input)).toBe('MY_VAR=value')
  })

  it('passes through lines that look like neither key=value nor comments', () => {
    // Edge case: malformed line. We don't try to be clever — preserve and move on.
    const input = ['STRIPE_KEY=ok', 'this is not a valid line', 'OTHER=ok'].join('\n')
    expect(extractCustomDevVars(input)).toBe(
      ['STRIPE_KEY=ok', 'this is not a valid line', 'OTHER=ok'].join('\n'),
    )
  })

  it('drops the SDK keys regardless of whitespace around them', () => {
    const input = ['  AUTH_JWT_ISSUER  =https://x', '  MY_KEY  =stays'].join('\n')
    expect(extractCustomDevVars(input)).toBe('  MY_KEY  =stays')
  })

  it('does NOT eat lines that look like keys but have spaces in the key name', () => {
    // `KEY WITH SPACES` is not a valid identifier; the line should pass through verbatim.
    const input = 'KEY WITH SPACES = value\nMY_KEY=stays'
    expect(extractCustomDevVars(input)).toBe('KEY WITH SPACES = value\nMY_KEY=stays')
  })

  it('strips an unterminated multi-line SDK value (eats to EOF)', () => {
    // PEM truncated mid-block (file corrupt). The parser must not leak
    // the partial PEM into the preserved-vars section.
    const input = [
      'STRIPE_KEY=ok',
      'AUTH_JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----',
      'corrupted partial value',
      // (no closing quote — file truncated here)
    ].join('\n')
    expect(extractCustomDevVars(input)).toBe('STRIPE_KEY=ok')
  })

  it('preserves an unterminated USER multi-line quoted value (also eats to EOF)', () => {
    // Same parser behavior, opposite outcome — user vars get kept.
    const input = ['MY_PEM="-----BEGIN PRIVATE KEY-----', 'AAAA'].join('\n')
    expect(extractCustomDevVars(input)).toBe('MY_PEM="-----BEGIN PRIVATE KEY-----\nAAAA')
  })

  it('strips the SDK divider so it does not accumulate across runs', () => {
    const input = [
      'STRIPE_KEY=ok',
      '# --- not managed by the SDK; preserved across dev/test runs ---',
      'OTHER=ok',
    ].join('\n')
    expect(extractCustomDevVars(input)).toBe('STRIPE_KEY=ok\nOTHER=ok')
  })

  it('preserves legacy/custom SDK_MANAGED keys below the divider', () => {
    // The same key appears above (SDK-managed, must drop) and below
    // (legacy/custom content, must keep). App-secret workflows should
    // use `npx deepspace secrets`; this protects older local files from
    // being clobbered during rewrites.
    const input = [
      'AUTH_JWT_ISSUER=https://drop.me',
      'ALLOW_DEBUG_ROUTES=true',     // SDK section — strip
      '# --- not managed by the SDK; preserved across dev/test runs ---',
      'ALLOW_DEBUG_ROUTES=true',     // legacy/custom section — keep
      'MY_TOKEN=keep',
    ].join('\n')
    expect(extractCustomDevVars(input)).toBe(
      ['ALLOW_DEBUG_ROUTES=true', 'MY_TOKEN=keep'].join('\n'),
    )
  })

  it('preserves any SDK-managed key when it appears below the divider', () => {
    // The above-vs-below distinction is purely positional — it applies
    // to every SDK_MANAGED_KEYS entry, not just ALLOW_DEBUG_ROUTES.
    const input = [
      '# --- not managed by the SDK; preserved across dev/test runs ---',
      'AUTH_JWT_ISSUER=user-override',
    ].join('\n')
    expect(extractCustomDevVars(input)).toBe('AUTH_JWT_ISSUER=user-override')
  })

  it('strips generated secrets cache before preserving custom vars for unlinked runs', () => {
    const input = [
      'MY_TOKEN=keep',
      '',
      renderSecretsCache({ API_KEY: 'stale' }, { appId: 'app_01HZXYABCDEFGHJKMNPQRSTVWX', configName: 'prd' }),
    ].join('\n')

    expect(extractCustomDevVars(stripGeneratedSecretsCache(input))).toBe('MY_TOKEN=keep')
  })
})

describe('parseDevVars', () => {
  it('parses simple KEY=value lines', () => {
    expect(parseDevVars('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('strips quotes from "value"', () => {
    expect(parseDevVars('FOO="bar"')).toEqual({ FOO: 'bar' })
  })

  it('preserves multi-line quoted values (PEM-shaped)', () => {
    const input = [
      'PEM="-----BEGIN PRIVATE KEY-----',
      'AAAA',
      'BBBB',
      '-----END PRIVATE KEY-----"',
    ].join('\n')
    const r = parseDevVars(input)
    expect(r.PEM).toBe('-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----')
  })

  it('unescapes \\" inside quoted values', () => {
    expect(parseDevVars('Q="he said \\"hi\\""')).toEqual({ Q: 'he said "hi"' })
  })

  it('round-trips escaped backslashes inside quoted values', () => {
    expect(parseDevVars('PATH="C:\\\\tmp\\\\cache"')).toEqual({ PATH: 'C:\\tmp\\cache' })
  })

  it('preserves unknown backslash escapes inside manually quoted values', () => {
    expect(parseDevVars('PATTERN="\\d+\\.json"')).toEqual({ PATTERN: '\\d+\\.json' })
  })

  it('skips comments and blank lines', () => {
    const input = ['# header', '', 'FOO=bar', '   ', '# trailing', 'BAZ=qux'].join('\n')
    expect(parseDevVars(input)).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('skips lines that look like keys but have spaces in the key name', () => {
    expect(parseDevVars('NOT A KEY = value\nOK=ok')).toEqual({ OK: 'ok' })
  })

  it('preserves embedded `=` characters in the value', () => {
    expect(parseDevVars('TOKEN=abc=def=ghi')).toEqual({ TOKEN: 'abc=def=ghi' })
  })

  it('handles bare empty value (`KEY=`)', () => {
    expect(parseDevVars('K=')).toEqual({ K: '' })
  })

  it('returns empty for empty input', () => {
    expect(parseDevVars('')).toEqual({})
  })

  it('throws on an unterminated multi-line quoted value', () => {
    // Without the throw, the leading `"` would silently end up inside the
    // secret value and corrupt every prod read. Better to fail loudly here.
    const input = ['MY_PEM="-----BEGIN PRIVATE KEY-----', 'AAAA'].join('\n')
    expect(() => parseDevVars(input)).toThrow(/unterminated quoted value.*MY_PEM/)
  })
})
