/**
 * App-secrets CLI lib: validation, upload parsing, download formatting, the
 * generated-cache render/strip round-trip, and pullAppSecretsCache's
 * missing-store tolerance. (The store's server behavior is covered in the
 * deploy-worker's suites; command wiring is exercised by e2e.)
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GENERATED_SECRETS_DIVIDER,
  defaultConfigNameForEnv,
  formatSecretsDownload,
  parseSecretsUpload,
  pullAppSecretsCache,
  quoteDotenvValue,
  renderSecretsCache,
  shellSingleQuote,
  stripGeneratedSecretsCache,
  validateConfigName,
  validateSecretName,
} from '../lib/secrets'
import { DEV_VARS_DIVIDER, extractCustomDevVars, parseDevVars } from '../env'

const APP_ID = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('validation', () => {
  it('accepts sane names and rejects the rest', () => {
    expect(validateSecretName('API_KEY')).toBe('API_KEY')
    expect(() => validateSecretName('1BAD')).toThrow()
    expect(() => validateSecretName('has-dash')).toThrow()
    expect(validateConfigName('prd')).toBe('prd')
    expect(validateConfigName('staging_2')).toBe('staging_2')
    expect(() => validateConfigName('bad name')).toThrow()
  })

  it('rejects SDK-managed keys client-side but allows ALLOW_DEBUG_ROUTES', () => {
    // Reserved/SDK-injected keys can't be set as app secrets — fail fast with a
    // clear message instead of a server round-trip that leaks the API path.
    expect(() => validateSecretName('APP_OWNER_JWT')).toThrow(/managed by the DeepSpace SDK/)
    expect(() => validateSecretName('AUTH_JWT_PUBLIC_KEY')).toThrow(/managed by the DeepSpace SDK/)
    // SDK-managed env that isn't a runtime binding is rejected too (proposal §4).
    expect(() => validateSecretName('API_WORKER_URL')).toThrow(/managed by the DeepSpace SDK/)
    expect(() => validateSecretName('PLATFORM_WORKER_URL')).toThrow(/managed by the DeepSpace SDK/)
    // ALLOW_DEBUG_ROUTES is a normal, user-settable config flag (off by default).
    expect(validateSecretName('ALLOW_DEBUG_ROUTES')).toBe('ALLOW_DEBUG_ROUTES')
  })

  it('config default follows the wrangler-env convention', () => {
    expect(defaultConfigNameForEnv()).toBe('prd')
    expect(defaultConfigNameForEnv('staging')).toBe('staging')
  })
})

describe('upload parsing', () => {
  it('parses dotenv with quoting and comments', () => {
    const parsed = parseSecretsUpload(
      ['# comment', 'PLAIN=abc', 'QUOTED="with \\"quotes\\" and spaces"', '', 'not a line'].join(
        '\n',
      ),
    )
    expect(parsed).toEqual({ PLAIN: 'abc', QUOTED: 'with "quotes" and spaces' })
  })

  it('parses multiline quoted values (a real PEM survives byte-exact)', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nBJAXHUsmUQ1j3ZqVWawiNQ==\n-----END PRIVATE KEY-----'
    const parsed = parseSecretsUpload(`BEFORE=1\nMULTI="\n${pem}\n"\nAFTER=2`)
    // The value round-trips with real newlines, and NO phantom key is minted
    // from the base64 continuation line (`BJAXHUsmUQ1j3ZqVWawiNQ==`).
    expect(parsed).toEqual({ BEFORE: '1', MULTI: `\n${pem}\n`, AFTER: '2' })
  })

  it('parses single-quoted multiline values literally (no escape processing)', () => {
    expect(parseSecretsUpload("K='line1\nliteral \\n stays'")).toEqual({
      K: 'line1\nliteral \\n stays',
    })
  })

  it('rejects an unterminated quoted value loudly instead of corrupting it', () => {
    expect(() => parseSecretsUpload('MULTI="\nnever closed')).toThrow(
      /Unterminated quoted value for "MULTI"/,
    )
  })

  it('a multiline value round-trips through its own download format', () => {
    const secrets = { PEMKEY: '-----BEGIN X-----\nabc==\n-----END X-----' }
    expect(parseSecretsUpload(formatSecretsDownload(secrets, 'dotenv'))).toEqual(secrets)
  })

  it('parses JSON objects and rejects non-string values', () => {
    expect(parseSecretsUpload('{"A":"1","B":"2"}')).toEqual({ A: '1', B: '2' })
    expect(() => parseSecretsUpload('{"A":1}')).toThrow()
    expect(() => parseSecretsUpload('["nope"]')).toThrow()
  })

  it('rejects reserved names in both JSON and dotenv uploads', () => {
    // The dotenv branch must fail as loudly as `set`/JSON, not silently ship a
    // reserved name and let the server reject it with a raw (400).
    expect(() => parseSecretsUpload('{"APP_OWNER_JWT":"x"}')).toThrow(/managed by the DeepSpace SDK/)
    expect(() => parseSecretsUpload('APP_OWNER_JWT=x')).toThrow(/managed by the DeepSpace SDK/)
    // A non-name line is still skipped silently (comments, blanks, junk).
    expect(parseSecretsUpload('# note\nOK=1\nnot a line')).toEqual({ OK: '1' })
  })
})

describe('download formatting', () => {
  const secrets = { B_KEY: 'plain', A_KEY: 'needs "quoting"' }

  it('dotenv sorts keys and quotes what needs it', () => {
    expect(formatSecretsDownload(secrets, 'dotenv')).toBe(
      'A_KEY="needs \\"quoting\\""\nB_KEY=plain\n',
    )
  })

  it('json and shell round the same data', () => {
    expect(JSON.parse(formatSecretsDownload(secrets, 'json'))).toEqual(secrets)
    // shell uses POSIX single-quoting (SEC-7), so even a plain value is quoted.
    expect(formatSecretsDownload(secrets, 'shell')).toContain("export B_KEY='plain'")
  })

  it('shell format preserves multiline values (PEM) as real newlines', () => {
    // dotenv/json flatten newlines; shell must keep them literal so that
    // `eval "$(… download --format shell)"` restores the value byte-for-byte.
    const pem = '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----'
    const out = formatSecretsDownload({ PEM: pem, WITH_QUOTE: "a'b" }, 'shell')
    expect(out).toContain(`export PEM='${pem}'`) // real newlines inside single quotes
    expect(out).toContain("export WITH_QUOTE='a'\\''b'") // embedded ' is closed/reopened
    expect(shellSingleQuote(pem)).toBe(`'${pem}'`)
  })

  it('quoteDotenvValue leaves safe strings bare', () => {
    expect(quoteDotenvValue('abc123_./:@+-')).toBe('abc123_./:@+-')
    expect(quoteDotenvValue('two words')).toBe('"two words"')
  })

  it('multiline values escape and round-trip instead of injecting extra vars', () => {
    const value = 'line1\nline2\rline3'
    const quoted = quoteDotenvValue(value)
    expect(quoted).not.toContain('\n') // one physical line
    const parsed = parseSecretsUpload(`KEY=${quoted}`)
    expect(parsed).toEqual({ KEY: value })
    // A PEM-ish value with escaped backslash-n text stays distinct from real newlines.
    const literal = 'has \\n literal'
    expect(parseSecretsUpload(`K=${quoteDotenvValue(literal)}`)).toEqual({ K: literal })
  })
})

describe('generated cache', () => {
  it('render → strip round-trips a .dev.vars body', () => {
    const cache = renderSecretsCache({ API_KEY: 'v1' }, { appId: APP_ID, configName: 'prd' })
    expect(cache).toContain(GENERATED_SECRETS_DIVIDER)
    expect(cache).toContain(`# app ${APP_ID} · config prd`)
    expect(cache).toContain('API_KEY=v1')

    const body = `SDK_VAR=1\n\n${cache}\n`
    expect(stripGeneratedSecretsCache(body)).toBe('SDK_VAR=1\n')
    expect(stripGeneratedSecretsCache('SDK_VAR=1\n')).toBe('SDK_VAR=1\n')
  })

  it('deploy only sees hand-edited vars, never generated-cache entries', () => {
    // Guards the local-only-vars warning against false positives: the deploy reads
    // `extractCustomDevVars(stripGeneratedSecretsCache(body))`. A stale cache entry
    // (a just-deleted secret, or another config's secrets in the shared .dev.vars)
    // must NOT surface as a "local-only" var — only genuinely hand-edited lines do.
    const cache = renderSecretsCache(
      { FROM_STORE: '1', DELETED_BUT_STALE: '2' },
      { appId: APP_ID, configName: 'prd' },
    )
    const body = [
      'AUTH_JWT_ISSUER=managed', // SDK-managed, above the divider → stripped
      DEV_VARS_DIVIDER,
      'MY_LOCAL=hand', // genuinely hand-edited → the only thing that should surface
      cache,
    ].join('\n')
    expect(parseDevVars(extractCustomDevVars(stripGeneratedSecretsCache(body)))).toEqual({
      MY_LOCAL: 'hand',
    })
  })
})

describe('pullAppSecretsCache', () => {
  it('returns values on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ secrets: { API_KEY: 'v' } })),
    )
    const pulled = await pullAppSecretsCache('https://deploy.test', 't', APP_ID, 'prd')
    expect(pulled).toEqual({ appId: APP_ID, configName: 'prd', values: { API_KEY: 'v' } })
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      `https://deploy.test/api/secrets/${APP_ID}/configs/prd/values`,
    )
  })

  it('treats a missing store/config (404) as "nothing to ship"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'app_not_found' }, { status: 404 })),
    )
    expect(await pullAppSecretsCache('https://deploy.test', 't', APP_ID, 'prd')).toBeNull()
  })

  it('propagates real failures with a clean message (server sentence, no API path) + status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'not_app_owner_or_collaborator' }, { status: 403 })),
    )
    const err = await pullAppSecretsCache('https://deploy.test', 't', APP_ID, 'prd').then(
      () => {
        throw new Error('expected pullAppSecretsCache to reject')
      },
      (e: Error & { status?: number; apiPath?: string }) => e,
    )
    // The user-facing message is the server's sentence, not the internal
    // `/api/secrets/app_…/configs/prd/values` path (SEC-6).
    expect(err.message).toBe('not_app_owner_or_collaborator')
    expect(err.message).not.toContain('/api/secrets')
    expect(err.status).toBe(403)
  })
})
