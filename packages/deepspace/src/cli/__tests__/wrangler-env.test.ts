import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveAppNameForEnv,
  devVarsPathFor,
  prepareWranglerEnvConfig,
  readWranglerConfig,
  wranglerViteEnv,
  WranglerConfigError,
  type WranglerConfig,
} from '../lib/wrangler-env'

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
  it('returns .dev.vars when no env is given', () => {
    expect(devVarsPathFor('/app', undefined)).toBe('/app/.dev.vars')
  })

  it('returns .dev.vars.<env> when env is given in legacy mode', () => {
    expect(devVarsPathFor('/app', 'staging')).toBe('/app/.dev.vars.staging')
  })

  it('returns shared .dev.vars when env is given in linked-secrets mode', () => {
    expect(devVarsPathFor('/app', 'staging', { sharedDevVarsCache: true })).toBe('/app/.dev.vars')
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

  it('keeps legacy CLOUDFLARE_ENV behavior unless linked secrets need the shared cache', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, '.dev.vars.staging'), 'OLD_SECRET=keep-for-user\n')
      writeFileSync(
        join(dir, 'wrangler.toml'),
        ['name = "hopkins"', '[env.staging]', 'name = "hopkins-staging"'].join('\n'),
      )

      const warnings: string[] = []
      const prepared = prepareWranglerEnvConfig(dir, 'staging', {
        warn: (message) => warnings.push(message),
      })
      expect(prepared.configPath).toBeUndefined()
      expect(warnings).toHaveLength(0)

      const childEnv = wranglerViteEnv({ CLOUDFLARE_ENV: 'ambient' }, prepared)
      expect(childEnv.CLOUDFLARE_ENV).toBe('staging')
      expect(childEnv.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH).toBeUndefined()
      expect(readFileSync(join(dir, '.dev.vars.staging'), 'utf-8')).toBe(
        'OLD_SECRET=keep-for-user\n',
      )
    })
  })

  it('flattens the selected env and makes .dev.vars win in linked-secrets mode', () => {
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
          '[env.staging]',
          'name = "hopkins-staging"',
          'route = "staging.example.com/*"',
          '[env.staging.vars]',
          'APP_NAME = "hopkins-staging"',
        ].join('\n'),
      )

      const warnings: string[] = []
      const prepared = prepareWranglerEnvConfig(dir, 'staging', {
        sharedDevVarsCache: true,
        warn: (message) => warnings.push(message),
      })
      expect(prepared.configPath).toBeDefined()
      expect(existsSync(prepared.configPath!)).toBe(true)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('.dev.vars.staging')
      expect(warnings[0]).toContain('.dev.vars')

      const generated = readFileSync(prepared.configPath!, 'utf-8')
      expect(generated).toContain('name = "hopkins-staging"')
      expect(generated).toContain('route = "staging.example.com/*"')
      expect(generated).toContain('APP_NAME = "hopkins-staging"')
      expect(generated).not.toContain('[env.staging')
      expect(generated).not.toContain('APP_NAME = "hopkins"\n')

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

  it('does nothing when no env is selected', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'wrangler.toml'), 'name = "hopkins"\n')
      const prepared = prepareWranglerEnvConfig(dir, undefined, {
        warn: () => expect.fail('unexpected warning'),
      })
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
