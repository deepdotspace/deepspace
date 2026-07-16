/**
 * DeepSpace environment configuration.
 *
 * Shared between `dev`, `test`, and `deploy` commands.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { stripGeneratedSecretsCache } from './lib/secrets'
export { stripGeneratedSecretsCache } // re-export: env.test + callers treat env as the .dev.vars surface
import { readAppId } from './lib/app-identity'
import { writeSecretFileSync } from './lib/secure-file'
import {
  devVarsPathFor,
  resolveAppNameForEnv,
  readWranglerConfig,
  hasWranglerConfig,
} from './lib/wrangler-env'

/**
 * Production DeepSpace platform URLs. The CLI always targets production
 * workers — there is no separate dev stack. Individual worker URLs can be
 * overridden per-command via the `DEEPSPACE_*_URL` env vars.
 */
export const PLATFORM_URLS = {
  auth: 'https://auth.deep.space',
  api: 'https://api-worker.deep.space',
  platform: 'https://platform-worker.deep.space',
  deploy: 'https://deploy-worker.deep.space',
} as const

/**
 * Web dashboard for managing deployed apps, billing, subscription plans,
 * earnings, etc. Linked from `login` and `whoami` so developers
 * discover it (the CLI alone gives no hint that it exists).
 */
export const DASHBOARD_URL = 'https://dashboard.deep.space'

/**
 * Fetch the JWT public key from an auth worker's /api/auth/jwks endpoint.
 */
export async function fetchPublicKey(authUrl: string): Promise<string> {
  const res = await fetch(`${authUrl}/api/auth/jwks`)
  if (!res.ok) {
    throw new Error(`Failed to fetch JWT public key (${res.status})`)
  }
  const data = (await res.json()) as { publicKey?: string }
  if (!data.publicKey) {
    throw new Error('JWKS response missing publicKey')
  }
  return data.publicKey
}

/**
 * Read the app name from the app's wrangler.toml. A non-canonical `name`
 * (e.g. `My_App` vs. `my-app`) is rejected with a clear error so wrangler.toml
 * stays the single source of truth — otherwise the canonical form would land
 * on deployed bindings and the registry while the raw form persisted in
 * `[vars].APP_NAME` and the client `SCOPE_ID`, splitting identity across
 * surfaces.
 *
 * `deepspace dev` runs in an app directory; the name is required.
 */
function requireAppIdFor(appDir: string, wranglerEnv?: string): string {
  const id = readAppId(appDir, wranglerEnv)
  if (id) return id
  throw new Error(
    'wrangler.toml has no DEEPSPACE_APP_ID' +
      (wranglerEnv ? ` for [env.${wranglerEnv}]` : '') +
      '. Run `deepspace init` (or `deepspace init --env <name>`) and retry.',
  )
}

function readAppName(appDir: string, wranglerEnv?: string): string {
  if (!hasWranglerConfig(appDir)) {
    throw new Error('No wrangler.toml found. Are you in a DeepSpace app directory?')
  }
  const config = readWranglerConfig(appDir)
  // Single source of truth — every command (deploy, dev, undeploy)
  // resolves through `resolveAppNameForEnv` so the validation rules
  // (missing block, empty name, collision with the top-level name,
  // canonical form) can never drift between them.
  const resolved = resolveAppNameForEnv(config, wranglerEnv)
  if (!resolved.ok) throw new Error(resolved.reason)

  // Refuse to proceed when the declared name doesn't already match the
  // canonical form. Otherwise the canonical name lands on deployed bindings
  // and the registry, while the raw name persists in `[vars].APP_NAME` —
  // splitting the identity across surfaces. (Scope keys are unaffected:
  // `SCOPE_ID = app:${APP_ID}` and the worker's `app:${env.DEEPSPACE_APP_ID}`
  // derive from the immutable app id, not the name.) Failing here forces the
  // dev to fix wrangler.toml once, after which every surface reads from the
  // same source of truth.
  const rawName = wranglerEnv ? config.env?.[wranglerEnv]?.name : config.name
  if (rawName !== resolved.name) {
    const where = wranglerEnv ? `[env.${wranglerEnv}].name` : '`name`'
    throw new Error(
      `wrangler.toml: ${where} "${rawName}" is not in canonical form. ` +
        `Update it to "${resolved.name}" and re-run.`,
    )
  }
  return resolved.name
}

/**
 * Mint a long-lived app-owner JWT from the auth worker.
 *
 * The caller passes their own short-lived user JWT (obtained via
 * `ensureToken()` from auth.ts) and the target env's auth URL. The auth
 * worker verifies the caller, signs a 10-year owner-scoped token bound to
 * `appName`, and returns it. This same token is used in dev (written into
 * `.dev.vars`) and in production (injected as a secret at deploy time).
 */
export async function mintAppOwnerJwt(
  authUrl: string,
  callerJwt: string,
  appName: string,
): Promise<string> {
  const res = await fetch(`${authUrl}/api/auth/mint-app-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${callerJwt}`,
    },
    body: JSON.stringify({ appId: appName }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Failed to mint APP_OWNER_JWT (${res.status}): ${err}`)
  }
  const body = (await res.json()) as { token?: string; error?: string }
  if (!body.token) {
    throw new Error(`Auth worker returned no token: ${body.error ?? 'unknown error'}`)
  }
  return body.token
}

/**
 * Fetch the per-app HMAC identity token from the deploy worker. The starter's
 * /_deepspace/* proxy attaches this token on every call to the API worker so
 * the platform can verify the request originated from a known app. In
 * production this is minted at deploy time and injected as a Worker binding;
 * in local dev we fetch it via this endpoint, which is gated by app ownership.
 */
export async function fetchAppIdentityToken(
  deployUrl: string,
  callerJwt: string,
  appName: string,
): Promise<string | null> {
  const res = await fetch(`${deployUrl}/api/apps/${encodeURIComponent(appName)}/identity-token`, { // appName carries the appId
    method: 'POST',
    headers: { Authorization: `Bearer ${callerJwt}` },
  })
  if (res.status === 404) {
    // App hasn't been deployed yet — pre-deploy dev workflow. The proxy will
    // 401 calls under /_deepspace/* until first deploy registers the app.
    return null
  }
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Failed to fetch APP_IDENTITY_TOKEN (${res.status}): ${err}`)
  }
  const body = (await res.json()) as { token?: string; error?: string }
  if (!body.token) {
    throw new Error(`Deploy worker returned no token: ${body.error ?? 'unknown error'}`)
  }
  return body.token
}

/**
 * Keys the SDK manages in the top section of .dev.vars. They're rewritten
 * on every `deepspace dev`/`test`/`deploy` run from the platform's truth
 * (auth URL, owner JWT, identity token, etc.). Keys that match this set
 * are stripped from the top section on read so they don't double-write.
 *
 * Critically: this set is only consulted above the legacy/custom divider.
 * Once we cross that divider, content is preserved so older workspaces and
 * local-only non-secret vars are not clobbered. New app secrets should flow
 * through `npx deepspace secrets`, which renders a generated cache section.
 */
const SDK_MANAGED_KEYS = new Set([
  'AUTH_JWT_PUBLIC_KEY',
  'AUTH_JWT_ISSUER',
  'AUTH_WORKER_URL',
  'API_WORKER_URL',
  'PLATFORM_WORKER_URL',
  'OWNER_USER_ID',
  'APP_OWNER_JWT',
  'APP_IDENTITY_TOKEN',
  'ALLOW_DEBUG_ROUTES',
])

// Marker the SDK writes between its own keys and user-managed content. We
// recognize and strip this line on read so it doesn't accumulate across runs.
export const DEV_VARS_DIVIDER = '# --- not managed by the SDK; preserved across dev/test runs ---'


interface WriteDevVarsOptions {
  /** The app's immutable id when the caller already resolved it; read from
   *  wrangler.toml otherwise. */
  appId?: string
  /**
   * Remote app secrets rendered as a generated dotenv cache. When present,
   * this replaces the legacy preserved section so the remote store stays the
   * source of truth.
   */
  generatedSecretsCache?: string
  /**
   * Linked secrets configs use a shared `.dev.vars` cache across Wrangler envs.
   * Unlinked apps keep Wrangler's legacy `.dev.vars.<env>` convention.
   */
  sharedDevVarsCache?: boolean
}

/**
 * Strip SDK-managed lines from an existing .dev.vars file, preserving all
 * other content (comments, blank lines, custom KEY=value pairs, multi-line
 * quoted values). Also strips the SDK divider marker so it doesn't double
 * up across runs.
 *
 * Exported for testing.
 */
export function extractCustomDevVars(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  // SDK-managed keys are only stripped above the divider. Once we cross
  // into the legacy/custom section, every line is preserved verbatim so
  // older workspaces and local-only non-secret vars survive rewrites.
  let belowDivider = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === DEV_VARS_DIVIDER.trim()) {
      // Drop our own divider — writeDevVars will re-add a single one.
      belowDivider = true
      i++
      continue
    }
    const eq = line.indexOf('=')
    const keyMatch = eq >= 0 ? line.slice(0, eq).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/) : null
    if (!keyMatch) {
      // Comment, blank, or non-key line — preserve verbatim.
      out.push(line)
      i++
      continue
    }
    const key = keyMatch[1]
    const valStart = line.slice(eq + 1)
    const block: string[] = [line]
    // Multi-line quoted value: opens with `"` and the rest of the line has no
    // closing quote. Keep accumulating until a closing `"` lands.
    if (valStart.startsWith('"') && !hasUnescapedQuote(valStart.slice(1))) {
      i++
      while (i < lines.length) {
        block.push(lines[i])
        const closed = hasUnescapedQuote(lines[i])
        i++
        if (closed) break
      }
    } else {
      i++
    }
    if (belowDivider || !SDK_MANAGED_KEYS.has(key)) {
      out.push(...block)
    }
  }
  // Trim trailing blanks so we don't accumulate them across runs.
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out.join('\n')
}

function hasUnescapedQuote(s: string): boolean {
  let escaped = false
  for (const ch of s) {
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') return true
  }
  return false
}

/**
 * Parse a `.dev.vars` (dotenv) string into a key→value map.
 *
 * Handles:
 *   - bare KEY=value
 *   - KEY="quoted value"
 *   - multi-line KEY="-----BEGIN ...\n-----END ..."
 *   - escaped quotes/backslashes inside (`KEY="he said \"hi\""` / `KEY="C:\\tmp"`)
 *   - comments and blank lines (skipped)
 *
 * Used for two things:
 *   1. parsing generated or legacy `.dev.vars` content so the CLI can ship
 *      app-defined secrets as `secret_text` bindings at deploy time
 *   2. round-tripping for tests
 *
 * Exported.
 */
export function parseDevVars(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      i++
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      i++
      continue
    }
    const keyMatch = line.slice(0, eq).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/)
    if (!keyMatch) {
      i++
      continue
    }
    const key = keyMatch[1]
    let value = line.slice(eq + 1)

    // Multi-line quoted value: opens with `"` and the rest of the line has
    // no closing quote. Keep accumulating until a closing `"` lands.
    let closed = !value.startsWith('"') || hasUnescapedQuote(value.slice(1))
    if (!closed) {
      i++
      while (i < lines.length) {
        value += '\n' + lines[i]
        if (hasUnescapedQuote(lines[i])) {
          closed = true
          i++
          break
        }
        i++
      }
    } else {
      i++
    }

    // Reject unterminated quoted values rather than silently corrupting the
    // secret. Without this guard, a `KEY="value with no closing quote` line
    // would round-trip through deploy as a literal leading `"` in the value
    // — a near-impossible bug to debug in production.
    if (value.startsWith('"') && !closed) {
      throw new Error(
        `parseDevVars: unterminated quoted value for key "${key}" — check your .dev.vars file for a missing closing quote.`,
      )
    }

    // Strip surrounding quotes and decode the same two escapes emitted by
    // generated secrets cache rendering. Other backslash sequences are left
    // untouched for compatibility with manually-authored dotenv files.
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = unescapeQuotedDevVar(value.slice(1, -1))
    }

    result[key] = value
  }
  return result
}

function unescapeQuotedDevVar(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch !== '\\' || i === value.length - 1) {
      out += ch
      continue
    }
    const next = value[i + 1]
    if (next === '\\' || next === '"') {
      out += next
      i++
      continue
    }
    out += ch
  }
  return out
}

/**
 * Write .dev.vars for an app, pointing to the specified environment's workers.
 *
 * Only the SDK-managed keys (see `SDK_MANAGED_KEYS`) are rewritten on each
 * call. Existing non-generated lines are preserved for compatibility, but app
 * secrets should be managed with `npx deepspace secrets`, not direct edits.
 *
 * Includes a freshly-minted `APP_OWNER_JWT` so server-side code in the app
 * (DO alarms, cron handlers, autonomous agents) can call the API worker
 * proxy without any further auth plumbing. Uses the same flow as production:
 * the auth-worker mints the token, we store it as an env var.
 */
export async function writeDevVars(
  appDir: string,
  ownerId: string,
  callerJwt: string,
  /** Wrangler [env.<name>] block to target. When set, mints
   *  APP_OWNER_JWT for that env's app (each env carries its own id). */
  wranglerEnv?: string,
  opts: WriteDevVarsOptions = {},
): Promise<void> {
  const urls = PLATFORM_URLS
  const publicKey = await fetchPublicKey(urls.auth)
  // Tokens key to the immutable app id (docs/proposals/app-identity-registry.md);
  // renames never rotate identity. `deepspace init` mints the id for repos
  // that predate it.
  const appId = opts.appId ?? requireAppIdFor(appDir, wranglerEnv)
  const appOwnerJwt = await mintAppOwnerJwt(urls.auth, callerJwt, appId)
  // Pre-first-deploy this returns null (the app isn't in the registry yet)
  // — that's expected. The /_deepspace/* proxy will start working after the
  // first `deepspace deploy` registers the app and a follow-up
  // `deepspace dev` re-runs this writer.
  const appIdentityToken = await fetchAppIdentityToken(urls.deploy, callerJwt, appId)

  // Wrangler's .dev.vars parser is dotenv-style: bare multi-line values are
  // truncated to the first line. The PEM public key spans multiple lines, so
  // it MUST be wrapped in double quotes (dotenv multi-line value syntax).
  // Without this, AUTH_JWT_PUBLIC_KEY ends up as just "-----BEGIN PUBLIC KEY-----"
  // and `importSPKI` throws `DataError: Invalid SPKI input`, which silently
  // breaks JWT verification on every WS connection (anonymous fallback).
  const sdkVars = [
    `AUTH_JWT_PUBLIC_KEY="${publicKey}"`,
    `AUTH_JWT_ISSUER=${urls.auth}/api/auth`,
    `AUTH_WORKER_URL=${urls.auth}`,
    `API_WORKER_URL=${urls.api}`,
    `PLATFORM_WORKER_URL=${urls.platform}`,
    `OWNER_USER_ID=${ownerId}`,
    `APP_OWNER_JWT=${appOwnerJwt}`,
    ...(appIdentityToken ? [`APP_IDENTITY_TOKEN=${appIdentityToken}`] : []),
    // Open /api/debug/* (proxied to RecordRoom) locally. This is the SDK's
    // dev-only auto-value; the deploy ships the remote store, not this
    // `.dev.vars` section, so it never reaches prod. To enable it on a deployed
    // env, `deepspace secrets set ALLOW_DEBUG_ROUTES=true`.
    `ALLOW_DEBUG_ROUTES=true`,
  ].join('\n')

  const useSharedDevVarsCache = opts.sharedDevVarsCache ?? opts.generatedSecretsCache !== undefined
  const devVarsPath = devVarsPathFor(appDir, wranglerEnv, {
    sharedDevVarsCache: useSharedDevVarsCache,
  })
  const existing = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf-8') : ''
  const custom =
    opts.generatedSecretsCache ?? extractCustomDevVars(stripGeneratedSecretsCache(existing).trimEnd())
  let body: string
  if (!custom) {
    body = `${sdkVars}\n`
  } else if (opts.generatedSecretsCache) {
    // The cache section carries its own divider header.
    body = `${sdkVars}\n\n${custom}\n`
  } else {
    body = `${sdkVars}\n\n${DEV_VARS_DIVIDER}\n${custom}\n`
  }

  writeSecretFileSync(devVarsPath, body)
}
