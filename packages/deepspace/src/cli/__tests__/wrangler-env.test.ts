import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAppNameForEnv,
  devVarsPathFor,
  prepareWranglerEnvConfig,
  readAppIdVar,
  readWranglerConfig,
  wranglerViteEnv,
  WranglerConfigError,
  type WranglerConfig,
} from '../lib/wrangler-env'
import { readAppId } from '../lib/app-identity'
import { errorCode } from '../lib/cli-errors'

const PROD_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0123'
const STAGING_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0456'

describe('resolveAppNameForEnv', () => {
  it('returns the top-level name when no env is given', () => {
    const r = resolveAppNameForEnv({ name: 'hopkins' }, undefined)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toBe('hopkins')
  })

  it('uses the [env.<name>] override when env is given', () => {
    const config: WranglerConfig = {
      name: 'hopkins',
      env: { staging: { name: 'hopkins-staging' } },
    }
    const r = resolveAppNameForEnv(config, 'staging')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toBe('hopkins-staging')
  })

  it('fails when the env block is missing entirely', () => {
    const config: WranglerConfig = { name: 'hopkins' }
    const r = resolveAppNameForEnv(config, 'staging')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no \[env\.staging\] block/)
  })

  it('codes a missing env block as missing_env_block, not invalid_app_name', () => {
    // `code` is the stable machine contract (docs sell it as such), so it has
    // to be true: nothing about a *name* is invalid here — the block is absent.
    const r = resolveAppNameForEnv({ name: 'hopkins' }, 'staging')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('missing_env_block')
  })

  it('leaves name failures uncoded so callers keep emitting invalid_app_name', () => {
    // These two really are about the name; only the missing-block case moved.
    const noName = resolveAppNameForEnv({ name: 'hopkins', env: { staging: {} } }, 'staging')
    expect(noName.ok).toBe(false)
    if (!noName.ok) expect(noName.code).toBeUndefined()

    const collides = resolveAppNameForEnv(
      { name: 'hopkins', env: { staging: { name: 'hopkins' } } },
      'staging',
    )
    expect(collides.ok).toBe(false)
    if (!collides.ok) expect(collides.code).toBeUndefined()
  })

  it('fails when the env block is present but has no name', () => {
    // Empty env block means the user intended an environment but forgot
    // the name. We don't fall back to the top-level name because that
    // would silently overwrite production.
    const config: WranglerConfig = {
      name: 'hopkins',
      env: { staging: {} },
    }
    const r = resolveAppNameForEnv(config, 'staging')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/\[env\.staging\]\.name is missing/)
  })

  it('fails when the env name collides with the top-level name', () => {
    // Same name = same deploy slot = staging clobbers prod. Always wrong.
    const config: WranglerConfig = {
      name: 'hopkins',
      env: { staging: { name: 'hopkins' } },
    }
    const r = resolveAppNameForEnv(config, 'staging')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/same as the top-level name/)
  })

  it('supports arbitrary env names (not just "staging")', () => {
    // The SDK is intentionally generic about env names: any block under
    // [env.<x>] works, so apps can build pr-123 / qa / dev / smoke envs
    // without the CLI special-casing them.
    const config: WranglerConfig = {
      name: 'hopkins',
      env: { 'pr-123': { name: 'hopkins-pr-123' } },
    }
    const r = resolveAppNameForEnv(config, 'pr-123')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.name).toBe('hopkins-pr-123')
  })
})

describe('devVarsPathFor', () => {
  it('returns the one generated .dev.vars path', () => {
    expect(devVarsPathFor('/app')).toBe('/app/.dev.vars')
  })
})

describe('prepareWranglerEnvConfig', () => {
  function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-env-test-'))
    try {
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('flattens the selected env so Wrangler reads the one generated cache', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '.dev.vars.staging'), 'OLD_SECRET=keep-for-user\n')
      writeFileSync(
        join(dir, 'wrangler.toml'),
        [
          'name = "hopkins"',
          'main = "worker.ts"',
          'compatibility_date = "2025-01-01"',
          '[vars]',
          'APP_NAME = "hopkins"',
          '[[durable_objects.bindings]]',
          'name = "ROOMS"',
          'class_name = "RecordRoom"',
          '[env.staging]',
          'name = "hopkins-staging"',
          'route = "staging.example.com/*"',
          '[env.staging.vars]',
          'APP_NAME = "hopkins-staging"',
        ].join('\n'),
      )

      const prepared = prepareWranglerEnvConfig(dir, 'staging')
      expect(prepared.configPath).toBeDefined()
      expect(existsSync(prepared.configPath!)).toBe(true)

      const generated = readFileSync(prepared.configPath!, 'utf-8')
      expect(generated).toContain('name = "hopkins-staging"')
      expect(generated).toContain('route = "staging.example.com/*"')
      expect(generated).toContain('APP_NAME = "hopkins-staging"')
      expect(generated).not.toContain('[env.staging')
      expect(generated).not.toContain('APP_NAME = "hopkins"\n')
      expect(generated).toContain('name = "ROOMS"')
      expect(generated).toContain('class_name = "RecordRoom"')

      const childEnv = wranglerViteEnv({ CLOUDFLARE_ENV: 'staging', KEEP: 'yes' }, prepared, {
        DEEPSPACE_PORT: '5173',
      })
      expect(childEnv.CLOUDFLARE_ENV).toBeUndefined()
      expect(childEnv.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH).toBe(prepared.configPath)
      expect(childEnv.KEEP).toBe('yes')
      expect(childEnv.DEEPSPACE_PORT).toBe('5173')

      prepared.cleanup()
      expect(existsSync(prepared.configPath!)).toBe(false)
      expect(readFileSync(join(dir, '.dev.vars.staging'), 'utf-8')).toBe(
        'OLD_SECRET=keep-for-user\n',
      )
    })
  })

  it('lets an environment explicitly replace top-level Durable Object bindings', () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, 'wrangler.toml'),
        [
          'name = "hopkins"',
          '[[durable_objects.bindings]]',
          'name = "ROOMS"',
          'class_name = "RecordRoom"',
          '[env.staging]',
          'name = "hopkins-staging"',
          '[[env.staging.durable_objects.bindings]]',
          'name = "STAGING_ROOMS"',
          'class_name = "StagingRecordRoom"',
        ].join('\n'),
      )

      const prepared = prepareWranglerEnvConfig(dir, 'staging')
      const generated = readFileSync(prepared.configPath!, 'utf-8')
      expect(generated).toContain('name = "STAGING_ROOMS"')
      expect(generated).not.toContain('name = "ROOMS"')
      expect(generated).toContain('APP_NAME = "hopkins-staging"')
      prepared.cleanup()
    })
  })

  it('does not inherit native rate-limit bindings into a named environment', () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, 'wrangler.toml'),
        [
          'name = "hopkins"',
          '[[ratelimits]]',
          'name = "PRODUCTION_LIMITER"',
          'namespace_id = "1001"',
          'simple = { limit = 10, period = 60 }',
          '[env.staging]',
          'name = "hopkins-staging"',
          '[[env.staging.ratelimits]]',
          'name = "STAGING_LIMITER"',
          'namespace_id = "1002"',
          'simple = { limit = 20, period = 60 }',
        ].join('\n'),
      )

      const prepared = prepareWranglerEnvConfig(dir, 'staging')
      const generated = readFileSync(prepared.configPath!, 'utf-8')
      expect(generated).toContain('name = "STAGING_LIMITER"')
      expect(generated).not.toContain('name = "PRODUCTION_LIMITER"')
      prepared.cleanup()
    })
  })

  it('does nothing when no env is selected', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'wrangler.toml'), 'name = "hopkins"\n')
      const prepared = prepareWranglerEnvConfig(dir, undefined)
      expect(prepared.configPath).toBeUndefined()
      const childEnv = wranglerViteEnv({ CLOUDFLARE_ENV: 'ambient' }, prepared)
      expect(childEnv.CLOUDFLARE_ENV).toBe('ambient')
      prepared.cleanup()
    })
  })
})

describe('readWranglerConfig', () => {
  function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-env-test-'))
    try {
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('parses a valid wrangler.toml', () => {
    withTempDir((dir) => {
      writeFileSync(
        join(dir, 'wrangler.toml'),
        ['name = "hopkins"', '[env.staging]', 'name = "hopkins-staging"'].join('\n'),
      )
      const config = readWranglerConfig(dir)
      expect(config.name).toBe('hopkins')
      expect(config.env?.staging?.name).toBe('hopkins-staging')
    })
  })

  it('reports a missing config through the same error shape', () => {
    // Three readers used to disagree here — `deepspace/build` said "missing or
    // not valid TOML", app-identity threw an InputError, and this one let a
    // raw ENOENT escape. One reader, one class, one machine code.
    withTempDir((dir) => {
      let caught: unknown
      try {
        readWranglerConfig(dir)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(WranglerConfigError)
      // A missing file is "not an app dir", not "a broken config" — its own
      // code and a sentence that says what to do about it.
      expect((caught as Error).message).toMatch(/No wrangler\.toml at .*Are you in a DeepSpace app directory\?/)
      expect(errorCode(caught)).toBe('not_in_app_repo')
    })
  })

  it('throws WranglerConfigError with the path on malformed TOML', () => {
    // Regression: previously the parser's raw stack trace was surfaced
    // to the user with no path context, leaving them to guess which
    // config was malformed in a multi-app repo.
    withTempDir((dir) => {
      writeFileSync(join(dir, 'wrangler.toml'), 'this is = not = valid TOML\n[unclosed')
      let caught: unknown
      try {
        readWranglerConfig(dir)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(WranglerConfigError)
      const err = caught as WranglerConfigError
      expect(err.path).toBe(join(dir, 'wrangler.toml'))
      expect(err.message).toContain('wrangler.toml: malformed TOML')
      expect(err.message).toContain(err.path)
      expect(errorCode(err)).toBe('invalid_config')
    })
  })

  it('parses the broadened WranglerConfig shape (assets + vars)', () => {
    // The interface intentionally exposes the optional fields callers
    // need so they don't have to one-off cast at the call site.
    withTempDir((dir) => {
      writeFileSync(
        join(dir, 'wrangler.toml'),
        [
          'name = "hopkins"',
          '[vars]',
          'APP_NAME = "hopkins"',
          '[assets]',
          'directory = "dist"',
          'run_worker_first = ["/api/*"]',
        ].join('\n'),
      )
      const config = readWranglerConfig(dir)
      expect(config.vars?.APP_NAME).toBe('hopkins')
      expect(config.assets?.directory).toBe('dist')
      expect(config.assets?.run_worker_first).toEqual(['/api/*'])
    })
  })
})

/**
 * One id under two sections. Copying the `[vars]` block into an env's block is
 * an easy edit and nothing detected it: both halves of the build then agree on
 * the same app, so the client id-mismatch guard has no mismatch to see, and
 * the user finds out only when the deploy `rename` guard trips over the env's
 * differing `name`. The guard lives in the one reader, so every consumer —
 * `deploy`, `status`, `readAppId`, the build's define — inherits it.
 */
describe('one section per app id', () => {
  function withConfig<T>(lines: string[], fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-dup-id-'))
    try {
      writeFileSync(join(dir, 'wrangler.toml'), `${lines.join('\n')}\n`)
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const DUPLICATED = [
    'name = "hopkins"',
    '[vars]',
    `DEEPSPACE_APP_ID = "${PROD_ID}"`,
    '[env.staging]',
    'name = "hopkins-staging"',
    '[env.staging.vars]',
    `DEEPSPACE_APP_ID = "${PROD_ID}"`,
  ]

  it('refuses the same id in [vars] and an env block, and says what to run', () => {
    withConfig(DUPLICATED, (dir) => {
      let caught: unknown
      try {
        readWranglerConfig(dir)
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(WranglerConfigError)
      const message = (caught as Error).message
      expect(message).toContain('[vars] and [env.staging.vars]')
      expect(message).toContain(PROD_ID)
      expect(message).toContain('each environment is its own app')
      expect(message).toContain('deepspace app init --env <name>')
      expect(errorCode(caught)).toBe('duplicate_app_id')
    })
  })

  it('refuses two env blocks sharing one id', () => {
    withConfig(
      [
        'name = "hopkins"',
        '[env.staging.vars]',
        `DEEPSPACE_APP_ID = "${STAGING_ID}"`,
        '[env.qa.vars]',
        `DEEPSPACE_APP_ID = "${STAGING_ID}"`,
      ],
      (dir) => {
        expect(() => readWranglerConfig(dir)).toThrow(/\[env\.staging\.vars\] and \[env\.qa\.vars\]/)
      },
    )
  })

  it('refuses through readAppId too — the guard is the reader, not a call site', () => {
    withConfig(DUPLICATED, (dir) => {
      expect(() => readAppId(dir)).toThrow(/each environment is its own app/)
      expect(() => readAppId(dir, 'staging')).toThrow(/each environment is its own app/)
    })
  })

  it('accepts distinct ids per section', () => {
    withConfig(
      [
        'name = "hopkins"',
        '[vars]',
        `DEEPSPACE_APP_ID = "${PROD_ID}"`,
        '[env.staging.vars]',
        `DEEPSPACE_APP_ID = "${STAGING_ID}"`,
      ],
      (dir) => {
        expect(readAppId(dir)).toBe(PROD_ID)
        expect(readAppId(dir, 'staging')).toBe(STAGING_ID)
        expect(readAppIdVar(readWranglerConfig(dir), 'staging')).toBe(STAGING_ID)
      },
    )
  })

  it('leaves a fresh scaffold initializable — the placeholder is not an id', () => {
    // `app init --env staging` has to be able to run on a template that
    // carries `__APP_ID__` in more than one place; only real ids collide.
    withConfig(
      [
        '[vars]',
        'DEEPSPACE_APP_ID = "__APP_ID__"',
        '[env.staging.vars]',
        'DEEPSPACE_APP_ID = "__APP_ID__"',
      ],
      (dir) => {
        expect(readAppId(dir)).toBeNull()
        expect(readAppId(dir, 'staging')).toBeNull()
      },
    )
  })

  it('returns null rather than throwing when there is no app here', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-dup-id-'))
    try {
      expect(readAppId(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
