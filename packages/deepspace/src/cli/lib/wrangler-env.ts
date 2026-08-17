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
 * DeepSpace keeps generated dev/test/deploy credentials in one `.dev.vars`
 * file. For `--env`, it flattens the selected Wrangler env into a generated
 * config for the Cloudflare Vite plugin instead of passing `CLOUDFLARE_ENV`;
 * otherwise Wrangler would look for a separate `.dev.vars.<env>` file.
 *
 * This module is also the ONE reader of `wrangler.toml` — `cli/lib/app-identity`
 * (ids) and `deepspace/build` (the browser's id define) both come through
 * {@link readWranglerConfigFile}, so there is one parse, one error shape, and
 * one place for a whole-file guard. It stays free of CLI-only imports for that
 * reason: the `deepspace/build` bundle pulls this in, and must not drag citty
 * or the prompt stack along with it.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { resolveAppName } from '../../server/rooms/app-name'
import { APP_ID_RE } from '../../server/utils/registry-client'

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
  cleanup(): void
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
  'ratelimits',
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
 * (matches the existing `resolveAppName` contract). A failure may carry a
 * `code`: the stable machine contract callers emit as `{ ok: false, code }`.
 * Absent, the failure is about the name itself (`invalid_app_name`) — a
 * missing env block is not, so it names itself.
 */
export function resolveAppNameForEnv(
  config: WranglerConfig,
  envName: string | undefined,
): { ok: true; name: string; warning?: string } | { ok: false; reason: string; code?: string } {
  if (!envName) {
    return resolveAppName(config.name)
  }
  const envBlock = config.env?.[envName]
  if (!envBlock) {
    return {
      ok: false,
      code: 'missing_env_block',
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

/** DeepSpace owns one generated local env file for every Wrangler environment. */
export function devVarsPathFor(appDir: string): string {
  return join(appDir, '.dev.vars')
}

export function prepareWranglerEnvConfig(
  appDir: string,
  envName: string | undefined,
): PreparedWranglerEnvConfig {
  if (!envName) return { cleanup() {} }

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
  // Durable Object declarations contain class bindings, not shared resource ids.
  // A named worker gets its own namespaces, so preserving the declarations is
  // both safe and required for SDK features to work outside the default env.
  if (!('durable_objects' in envBlock) && config.durable_objects) {
    flattened.durable_objects = config.durable_objects
  }
  const envVars = asTomlRecord(envBlock.vars) ?? {}
  if (!('APP_NAME' in envVars) && typeof envBlock.name === 'string') {
    flattened.vars = { ...envVars, APP_NAME: envBlock.name }
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
 * The one failure shape for reading wrangler.toml — unreadable, malformed, or
 * self-contradictory. Carries the absolute path so the user is not left
 * staring at a raw smol-toml stack trace guessing which config in a multi-app
 * repo is broken, and a machine `code` so `--json` callers keep getting one
 * (`cli-errors.errorCode` recognizes this class by name, since this module
 * must not import the CLI error stack — see the header).
 */
export class WranglerConfigError extends Error {
  constructor(
    public readonly path: string,
    message: string,
    public readonly code: string = 'invalid_config',
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'WranglerConfigError'
  }
}

function causeDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Read + parse one wrangler.toml by absolute path. The single reader: every
 * consumer of this file in the SDK (deploy/status/dev, `readAppId`, and the
 * build's `__DEEPSPACE_APP_ID__` define) lands here, so a config that is wrong
 * is refused once, the same way, wherever it is read.
 */
export function readWranglerConfigFile(path: string): WranglerConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
    throw new WranglerConfigError(
      path,
      missing ? noWranglerConfigMessage(path) : `wrangler.toml: could not read ${path}: ${causeDetail(err)}`,
      missing ? 'not_in_app_repo' : 'invalid_config',
      err,
    )
  }
  let config: WranglerConfig
  try {
    config = parseToml(raw) as WranglerConfig
  } catch (err) {
    throw new WranglerConfigError(
      path,
      `wrangler.toml: malformed TOML at ${path}: ${causeDetail(err)}`,
      'invalid_config',
      err,
    )
  }
  assertOneSectionPerAppId(config, path)
  return config
}

/** Read + parse `<appDir>/wrangler.toml`. Caller may check existence first via
 *  `hasWranglerConfig` to distinguish "no app here" from "broken app here". */
export function readWranglerConfig(appDir: string): WranglerConfig {
  return readWranglerConfigFile(join(appDir, 'wrangler.toml'))
}

/**
 * The raw `DEEPSPACE_APP_ID` of one section — `[env.<envName>.vars]` when an
 * env is named, `[vars]` otherwise. Env blocks do NOT inherit the top-level
 * id: each environment is its own app, and silently inheriting is what once
 * shipped a staging worker beside a production browser.
 */
export function readAppIdVar(config: WranglerConfig, envName?: string): unknown {
  return (envName ? config.env?.[envName]?.vars : config.vars)?.DEEPSPACE_APP_ID
}

/**
 * Refuse a config that gives one app id to more than one section.
 *
 * Copying the `[vars]` block into `[env.staging.vars]` leaves both halves of a
 * build agreeing on the same app while the deploy targets another — the client
 * id-mismatch guard cannot fire, because there is no mismatch to see. Only
 * real (`app_…`-shaped) ids count, so a fresh scaffold's repeated `__APP_ID__`
 * placeholder is still initializable.
 */
function assertOneSectionPerAppId(config: WranglerConfig, path: string): void {
  const sections = new Map<string, string[]>()
  const record = (section: string, value: unknown) => {
    if (typeof value !== 'string' || !APP_ID_RE.test(value)) return
    sections.set(value, [...(sections.get(value) ?? []), section])
  }
  record('[vars]', config.vars?.DEEPSPACE_APP_ID)
  for (const envName of Object.keys(config.env ?? {})) {
    record(`[env.${envName}.vars]`, config.env?.[envName]?.vars?.DEEPSPACE_APP_ID)
  }
  for (const [appId, where] of sections) {
    if (where.length < 2) continue
    throw new WranglerConfigError(
      path,
      `wrangler.toml: ${where.join(' and ')} ${where.length === 2 ? 'both' : 'all'} set DEEPSPACE_APP_ID = "${appId}" in ${path}. ` +
        `One id under several sections points every environment's data, secrets, and billing at the ` +
        `same app while the deploys go to different places — each environment is its own app — ` +
        `run \`deepspace app init --env <name>\` to mint one for it.`,
      'duplicate_app_id',
    )
  }
}

/**
 * The one "not in an app directory" sentence — the reader's own, and what
 * every command that pre-checks for wrangler.toml says (`not_in_app_repo`),
 * so an agent meets one text with one remedy wherever it hits this.
 */
export function noWranglerConfigMessage(where: string): string {
  return `No wrangler.toml at ${where}. Are you in a DeepSpace app directory? (Scaffold one with \`npm create deepspace\`, or cd into an existing app.)`
}

/** Convenience: true when wrangler.toml exists at the standard path. */
export function hasWranglerConfig(appDir: string): boolean {
  return existsSync(join(appDir, 'wrangler.toml'))
}
