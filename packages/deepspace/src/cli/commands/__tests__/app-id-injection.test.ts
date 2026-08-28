/**
 * The client app id comes from wrangler.toml, not a literal.
 *
 * Regression: `src/constants.ts` used to hold `export const APP_ID = 'app_…'`,
 * substituted once at scaffold time from the DEFAULT environment. `deepspace
 * deploy --env staging` flattens `[env.staging]` into a generated config for
 * the worker, but the browser bundle kept the scaffold-time literal — so
 * staging's worker wrote staging's RecordRooms while staging's browser read
 * production's, and the deploy reported ok:true with no warning.
 *
 * The resolver now lives in the SDK (`deepspace/build`) and an app's build
 * config imports it, so this exercises the SDK's own function plus the scaffold
 * wiring that feeds it into the bundle.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { resolveAppId } from '../../../build/app-id'
import { TEMPLATES_DIR } from './template-assembly'

const BASE = join(TEMPLATES_DIR, 'base')
const PROD_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0123'
const STAGING_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0456'

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'app-id-injection-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeConfig(dir: string, lines: string[]): string {
  const path = join(dir, 'wrangler.toml')
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

describe('resolveAppId', () => {
  it('reads the flattened config `deploy --env <name>` generates', () => {
    // What deploy actually does: prepareWranglerEnvConfig writes the selected
    // env flattened to top level and points the build at it with
    // CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH (CLOUDFLARE_ENV is deleted).
    withTempDir((dir) => {
      const path = writeConfig(dir, [
        'name = "hopkins-staging"',
        '[vars]',
        `DEEPSPACE_APP_ID = "${STAGING_ID}"`,
      ])
      expect(
        resolveAppId({ appDir: dir, env: { CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: path } }),
      ).toBe(STAGING_ID)
    })
  })

  it('reads [env.<name>.vars] when CLOUDFLARE_ENV selects an environment', () => {
    withTempDir((dir) => {
      const path = writeConfig(dir, [
        'name = "hopkins"',
        '[vars]',
        `DEEPSPACE_APP_ID = "${PROD_ID}"`,
        '[env.staging]',
        'name = "hopkins-staging"',
        '[env.staging.vars]',
        `DEEPSPACE_APP_ID = "${STAGING_ID}"`,
      ])
      expect(
        resolveAppId({
          appDir: dir,
          env: { CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: path, CLOUDFLARE_ENV: 'staging' },
        }),
      ).toBe(STAGING_ID)
      // …and the default env still gets its own id from the same file.
      expect(
        resolveAppId({ appDir: dir, env: { CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: path } }),
      ).toBe(PROD_ID)
    })
  })

  it('resolves wrangler.toml from the app dir when no config path is set', () => {
    // A bare `vite build` sets no CLOUDFLARE_* vars; the config is read relative
    // to the appDir the vite.config passes, not a guessed cwd.
    withTempDir((dir) => {
      writeConfig(dir, ['[vars]', `DEEPSPACE_APP_ID = "${PROD_ID}"`])
      expect(resolveAppId({ appDir: dir, env: {} })).toBe(PROD_ID)
    })
  })

  it('refuses to fall back to the top-level id when the env declares none', () => {
    // The whole defect in one assertion: silently inheriting production's id
    // here is what shipped a staging browser pointed at production's rooms.
    withTempDir((dir) => {
      const path = writeConfig(dir, [
        'name = "hopkins"',
        '[vars]',
        `DEEPSPACE_APP_ID = "${PROD_ID}"`,
        '[env.staging]',
        'name = "hopkins-staging"',
      ])
      expect(() =>
        resolveAppId({
          appDir: dir,
          env: { CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: path, CLOUDFLARE_ENV: 'staging' },
        }),
      ).toThrow(/\[env\.staging\.vars\] has no valid DEEPSPACE_APP_ID/)
    })
  })

  it('fails the build on a malformed id rather than shipping it', () => {
    withTempDir((dir) => {
      writeConfig(dir, ['[vars]', 'DEEPSPACE_APP_ID = "not-an-app-id"'])
      expect(() => resolveAppId({ appDir: dir, env: {} })).toThrow(/no valid DEEPSPACE_APP_ID/)
    })
  })

  it('fails loudly when the config is missing entirely', () => {
    withTempDir((dir) => {
      expect(() => resolveAppId({ appDir: dir, env: {} })).toThrow(/No wrangler\.toml at/)
    })
  })

  it('inherits the shared reader’s one-section-per-id guard', () => {
    // The resolver no longer parses wrangler.toml itself — it goes through the
    // CLI's single reader, so a config the CLI refuses cannot slip into a
    // bundle by way of a bare `vite build`. The guard's own cases live in
    // cli/__tests__/wrangler-env.test.ts.
    withTempDir((dir) => {
      writeConfig(dir, [
        '[vars]',
        `DEEPSPACE_APP_ID = "${PROD_ID}"`,
        '[env.staging.vars]',
        `DEEPSPACE_APP_ID = "${PROD_ID}"`,
      ])
      expect(() => resolveAppId({ appDir: dir, env: {} })).toThrow(
        /each environment is its own app/,
      )
    })
  })
})

describe('scaffold wiring', () => {
  it('keeps wrangler.toml as the only place the id is written at scaffold time', () => {
    expect(readFileSync(join(BASE, 'wrangler.toml'), 'utf-8')).toContain(
      'DEEPSPACE_APP_ID = "__APP_ID__"',
    )
  })

  it('ships no per-app resolver copy — the SDK owns it', () => {
    expect(existsSync(join(BASE, 'wrangler-app-id.ts'))).toBe(false)
  })

  it('has no app-id literal in the client constants', () => {
    const constants = readFileSync(join(BASE, 'src', 'constants.ts'), 'utf-8')
    expect(constants).not.toContain('__APP_ID__')
    expect(constants).not.toMatch(/app_[0-9A-HJKMNP-TV-Z]{26}/)
    expect(constants).toContain('__DEEPSPACE_APP_ID__')
    expect(constants).toContain('app:${APP_ID}')
  })

  it('injects the id into every build config that can produce a bundle', () => {
    const vite = readFileSync(join(BASE, 'vite.config.ts'), 'utf-8')
    expect(vite).toContain("from 'deepspace/build'")
    expect(vite).toMatch(/deepspaceBuild\(\{\s*appDir/)

    const vitest = readFileSync(join(BASE, 'vitest.config.ts'), 'utf-8')
    expect(vitest).toContain("from 'deepspace/build'")
    expect(vitest).toMatch(/define:\s*appIdDefine\(\{\s*appDir/)
  })
})
