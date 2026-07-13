/**
 * Wrangler env resolution for DeepSpace's multi-environment deploys.
 *
 * Lets a single repo deploy to `<app>.app.space` and `<app>-staging.app.space`
 * (or any other named environment) from one `wrangler.toml`:
 *
 *   name = "hopkins"
 *   [vars]
 *   APP_NAME = "hopkins"
 *
 *   [env.staging]
 *   name = "hopkins-staging"
 *   [env.staging.vars]
 *   APP_NAME = "hopkins-staging"
 *
 * Then `npx deepspace deploy --env staging` reads the override and ships to
 * `hopkins-staging.app.space`. The platform treats it as a fully separate
 * app — its own DO state, OAuth tokens, Stripe products, cron schedule.
 * No platform-side change needed beyond letting the CLI register a second
 * app under the same owner.
 *
 * When an app links a remote secrets project, DeepSpace keeps generated
 * dev/test/deploy credentials in a single `.dev.vars` cache so named
 * environments do not leave extra local files. In that linked-secrets mode,
 * `--env` flattens the selected Wrangler env into a generated config for the
 * Cloudflare Vite plugin instead of passing `CLOUDFLARE_ENV`; otherwise
 * Wrangler would prefer legacy `.dev.vars.<env>` files over the shared cache.
 * Unlinked apps keep Wrangler's legacy env-file behavior.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { resolveAppName } from '../../server/rooms/app-name'

/** Shape of the bits of wrangler.toml that DeepSpace CLI commands read.
 *  Add an optional field here whenever a new command starts consulting
 *  the config — avoids one-off `WranglerConfig & { … }` casts at
 *  call sites and keeps the canonical type in one place. */
export interface WranglerConfig {
  name?: string
  env?: Record<
    string,
    ({ name?: string; vars?: Record<string, unknown> } & Record<string, unknown>) | undefined
  >
  /** `[assets]` block (`directory`, `binding`, `not_found_handling`,
   *  `run_worker_first`). Consumed by deploy.ts to merge extra
   *  worker-first routes into the deployed metadata. */
  assets?: {
    directory?: string
    binding?: string
    not_found_handling?: string
    run_worker_first?: unknown
  }
  /** `[vars]` block — string-valued environment variables baked into
   *  the worker at deploy time. */
  vars?: Record<string, unknown>
}

export interface PreparedWranglerEnvConfig {
  configPath?: string
  wranglerEnv?: string
  cleanup(): void
}

export interface WranglerEnvModeOptions {
  sharedDevVarsCache?: boolean
}

type TomlRecord = Record<string, unknown>

const NON_INHERITABLE_ENV_KEYS = new Set([
  'define',
  'vars',
  'durable_objects',
  'kv_namespaces',
  'r2_buckets',
  'ai_search_namespaces',
  'ai_search',
  'vectorize',
  'services',
  'queues',
  'workflows',
  'tail_consumers',
  'secrets',
  'secrets_store_secrets',
])

let generatedConfigSeq = 0

/**
 * Resolve the appName that this CLI invocation should target.
 *
 * Without `envName`: returns the top-level `name`.
 * With `envName`:    returns `[env.<envName>].name` and requires that the
 *                    env block exists and declares a name. We refuse to
 *                    fall back to the top-level name because that would
 *                    silently deploy staging code to production.
 *
 * Returns a discriminated union so callers can surface a precise error
 * (matches the existing `resolveAppName` contract).
 */
export function resolveAppNameForEnv(
  config: WranglerConfig,
  envName: string | undefined,
): { ok: true; name: string; warning?: string } | { ok: false; reason: string } {
  if (!envName) {
    return resolveAppName(config.name)
  }
  const envBlock = config.env?.[envName]
  if (!envBlock) {
    return {
      ok: false,
      reason:
        `wrangler.toml: no [env.${envName}] block found. ` +
        `Add one with a distinct \`name\` to deploy this environment.`,
    }
  }
  if (typeof envBlock.name !== 'string' || envBlock.name.trim() === '') {
    return {
      ok: false,
      reason:
        `wrangler.toml: [env.${envName}].name is missing. ` +
        `Set a distinct app name (e.g. "${typeof config.name === 'string' ? config.name : 'myapp'}-${envName}") so this environment doesn't overwrite the default.`,
    }
  }
  if (envBlock.name === config.name) {
    return {
      ok: false,
      reason:
        `wrangler.toml: [env.${envName}].name "${envBlock.name}" is the same as the top-level name. ` +
        `Pick a distinct name (e.g. "${config.name}-${envName}") so deploys don't collide.`,
    }
  }
  return resolveAppName(envBlock.name)
}

/** The .dev.vars path for the selected mode. Linked secrets use a shared cache. */
export function devVarsPathFor(
  appDir: string,
  envName: string | undefined,
  opts: WranglerEnvModeOptions = {},
): string {
  if (opts.sharedDevVarsCache || !envName) return join(appDir, '.dev.vars')
  return join(appDir, `.dev.vars.${envName}`)
}

export function legacyEnvDevVarsPathFor(
  appDir: string,
  envName: string | undefined,
): string | undefined {
  return envName ? join(appDir, `.dev.vars.${envName}`) : undefined
}

export function warnIfLegacyEnvDevVarsExists(
  appDir: string,
  envName: string | undefined,
  warn: (message: string) => void = console.warn,
): void {
  const legacyPath = legacyEnvDevVarsPathFor(appDir, envName)
  if (!legacyPath || !existsSync(legacyPath)) return
  warn(
    `Warning: ${legacyPath} exists, but DeepSpace now uses ${devVarsPathFor(appDir, envName, { sharedDevVarsCache: true })} ` +
      `for every environment. This run will ignore ${legacyPath}; move any secrets you still ` +
      `need into .dev.vars, then remove the env-specific file when you're ready.`,
  )
}

export function prepareWranglerEnvConfig(
  appDir: string,
  envName: string | undefined,
  opts: { warn?: (message: string) => void } & WranglerEnvModeOptions = {},
): PreparedWranglerEnvConfig {
  if (!envName) return { cleanup() {} }
  if (!opts.sharedDevVarsCache) return { wranglerEnv: envName, cleanup() {} }

  warnIfLegacyEnvDevVarsExists(appDir, envName, opts.warn)

  const config = readWranglerConfig(appDir)
  const resolved = resolveAppNameForEnv(config, envName)
  if (!resolved.ok) throw new Error(resolved.reason)
  const flattened = flattenWranglerEnvConfig(config as TomlRecord, envName)
  const configPath = join(
    appDir,
    `.wrangler.deepspace.${safeGeneratedConfigSegment(envName)}.${process.pid}.${++generatedConfigSeq}.toml`,
  )
  writeFileSync(
    configPath,
    [
      '# Generated by DeepSpace for this CLI run.',
      '# Do not edit; wrangler.toml remains the source of truth.',
      stringifyToml(flattened),
    ]
      .join('\n')
      .replace(/\s*$/u, '\n'),
  )
  return {
    configPath,
    cleanup() {
      rmSync(configPath, { force: true })
    },
  }
}

export function wranglerViteEnv(
  baseEnv: NodeJS.ProcessEnv,
  prepared: PreparedWranglerEnvConfig,
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...baseEnv, ...extraEnv }
  if (prepared.configPath) {
    delete env.CLOUDFLARE_ENV
    env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH = prepared.configPath
  } else if (prepared.wranglerEnv) {
    env.CLOUDFLARE_ENV = prepared.wranglerEnv
  }
  return env
}

function flattenWranglerEnvConfig(config: TomlRecord, envName: string): TomlRecord {
  const envRoot = asTomlRecord(config.env)
  const envBlock = asTomlRecord(envRoot?.[envName])
  if (!envBlock) {
    throw new Error(`wrangler.toml: no [env.${envName}] block found.`)
  }

  const flattened: TomlRecord = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === 'env' || NON_INHERITABLE_ENV_KEYS.has(key)) continue
    flattened[key] = value
  }
  for (const [key, value] of Object.entries(envBlock)) {
    flattened[key] = value
  }
  return flattened
}

function asTomlRecord(value: unknown): TomlRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as TomlRecord)
    : undefined
}

function safeGeneratedConfigSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_')
}

/**
 * Read + parse wrangler.toml. Caller checks existence first via
 * `hasWranglerConfig`. Throws a `WranglerConfigError` with the absolute
 * path embedded on a malformed file — saves the user from staring at
 * a raw smol-toml parser stack trace when they have one stray
 * unquoted character in their config.
 */
export class WranglerConfigError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`wrangler.toml: malformed TOML at ${path}: ${detail}`)
    this.name = 'WranglerConfigError'
  }
}

export function readWranglerConfig(appDir: string): WranglerConfig {
  const path = join(appDir, 'wrangler.toml')
  const raw = readFileSync(path, 'utf-8')
  try {
    return parseToml(raw) as WranglerConfig
  } catch (err) {
    throw new WranglerConfigError(path, err)
  }
}

/** Convenience: true when wrangler.toml exists at the standard path. */
export function hasWranglerConfig(appDir: string): boolean {
  return existsSync(join(appDir, 'wrangler.toml'))
}
