/**
 * App secrets — client helpers for the app-anchored store
 * (docs/proposals/app-identity-registry.md §4.3).
 *
 * Every app has exactly one store, addressed by its immutable id:
 * `/api/secrets/:appId/configs/:config/...` on the deploy worker. Configs
 * follow the wrangler-env convention: the top-level config is `prd`, an
 * `--env staging` deploy ships the `staging` config. There are no per-user
 * projects and no app↔project links — those concepts are gone.
 */

import { RESERVED_BINDING_NAMES } from '../../server/rooms/binding-manifest'
import { ApiError } from './api'

/**
 * Names a user may not set as an app secret. `RESERVED_BINDING_NAMES` covers
 * runtime bindings the platform injects; `API_WORKER_URL`/`PLATFORM_WORKER_URL`
 * are SDK-managed env that isn't a binding (so absent from that set) but is
 * still platform-owned. `ALLOW_DEBUG_ROUTES` is deliberately NOT here — it's a
 * normal, user-settable flag. Rejecting these client-side gives a clear message
 * instead of a raw server `(400)` that leaks the API path.
 */
const RESERVED_SECRET_NAMES = new Set([
  ...RESERVED_BINDING_NAMES,
  'API_WORKER_URL',
  'PLATFORM_WORKER_URL',
])

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const CONFIG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MAX_SECRET_VALUE_BYTES = 32 * 1024

export interface SecretListItem {
  key: string
  version: number
  updatedAt: string
  updatedBy: string
}

export interface SecretsConfigInfo {
  name: string
  createdAt: string
  updatedAt: string
  secretCount?: number
}

export interface PulledSecretsCache {
  appId: string
  configName: string
  values: Record<string, string>
}

export interface RefreshedSecretsCache {
  /** Null means the selected config does not exist yet. */
  pulled: PulledSecretsCache | null
  /** Always materialized, including an absent config, so stale local values disappear. */
  rendered: string
  summary: string | null
}

export type SecretsDownloadFormat = 'dotenv' | 'json' | 'shell'

export function validateConfigName(configName: string): string {
  if (!CONFIG_NAME_RE.test(configName)) {
    throw new Error(
      `Invalid config "${configName}". Use letters, numbers, underscores, or hyphens; start with a letter or number.`,
    )
  }
  return configName
}

export function validateSecretName(name: string): string {
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(
      `Invalid secret name "${name}". Use letters, numbers, and underscores; start with a letter or underscore.`,
    )
  }
  if (RESERVED_SECRET_NAMES.has(name)) {
    throw new Error(
      `"${name}" is managed by the DeepSpace SDK and can't be set as an app secret — ` +
        'the platform injects it at deploy time.',
    )
  }
  return name
}

export function validateSecretValue(key: string, value: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_SECRET_VALUE_BYTES) {
    throw new Error(`Secret "${key}" exceeds ${MAX_SECRET_VALUE_BYTES} bytes`)
  }
}

/** Config convention: top-level deploys/dev use `prd`; a wrangler env uses
 *  its own name. */
export function defaultConfigNameForEnv(wranglerEnv?: string): string {
  return wranglerEnv ?? 'prd'
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

export async function secretsApi<T>(
  deployUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${deployUrl}/api/secrets${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    // Surface the server's sentence, not the internal `/api/secrets/app_…/…`
    // slug — that path is an implementation detail and reads like a bug to
    // users. `status` carries the code for programmatic branches; set DEBUG=1
    // (via cli-errors) for the full error. `apiPath` is kept for debugging.
    const err = new Error(body.error ?? `Secrets request failed (${res.status})`) as Error & {
      status?: number
      code?: string
      apiPath?: string
    }
    err.status = res.status
    // Preserve the server's machine code (e.g. app_not_registered) so the
    // shared renderer and --json envelope expose it instead of a bare slug.
    err.code = (body as { code?: string }).code
    err.apiPath = path
    throw err
  }
  return body
}

export function listSecrets(
  deployUrl: string,
  token: string,
  appId: string,
  configName: string,
): Promise<{ secrets: SecretListItem[] }> {
  return secretsApi(deployUrl, token, `/${appId}/configs/${encodeURIComponent(configName)}`)
}

export function fetchSecretsValues(
  deployUrl: string,
  token: string,
  appId: string,
  configName: string,
): Promise<{ secrets: Record<string, string> }> {
  return secretsApi(deployUrl, token, `/${appId}/configs/${encodeURIComponent(configName)}/values`)
}

export function getSecretPlain(
  deployUrl: string,
  token: string,
  appId: string,
  configName: string,
  key: string,
): Promise<{ key: string; value: string }> {
  return secretsApi(
    deployUrl,
    token,
    `/${appId}/configs/${encodeURIComponent(configName)}/secrets/${encodeURIComponent(key)}?plain=true`,
  )
}

export function setSecret(
  deployUrl: string,
  token: string,
  appId: string,
  configName: string,
  key: string,
  value: string,
): Promise<{ ok: boolean }> {
  return secretsApi(
    deployUrl,
    token,
    `/${appId}/configs/${encodeURIComponent(configName)}/secrets/${encodeURIComponent(key)}`,
    { method: 'PUT', body: JSON.stringify({ value }) },
  )
}

export function deleteSecret(
  deployUrl: string,
  token: string,
  appId: string,
  configName: string,
  key: string,
): Promise<{ ok: boolean }> {
  return secretsApi(
    deployUrl,
    token,
    `/${appId}/configs/${encodeURIComponent(configName)}/secrets/${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  )
}

export function uploadSecrets(
  deployUrl: string,
  token: string,
  appId: string,
  configName: string,
  secrets: Record<string, string>,
  replace: boolean,
): Promise<{ ok: boolean }> {
  return secretsApi(
    deployUrl,
    token,
    `/${appId}/configs/${encodeURIComponent(configName)}/secrets`,
    { method: 'PUT', body: JSON.stringify({ secrets, replace }) },
  )
}

export function listConfigs(
  deployUrl: string,
  token: string,
  appId: string,
): Promise<{ configs: SecretsConfigInfo[] }> {
  return secretsApi(deployUrl, token, `/${appId}/configs`)
}

export function createConfig(
  deployUrl: string,
  token: string,
  appId: string,
  configName: string,
  copyFrom?: string,
): Promise<{ ok: boolean }> {
  return secretsApi(deployUrl, token, `/${appId}/configs`, {
    method: 'POST',
    body: JSON.stringify({ name: configName, ...(copyFrom ? { copyFrom } : {}) }),
  })
}

export function deleteConfig(
  deployUrl: string,
  token: string,
  appId: string,
  configName: string,
): Promise<{ ok: boolean }> {
  return secretsApi(deployUrl, token, `/${appId}/configs/${encodeURIComponent(configName)}`, {
    method: 'DELETE',
  })
}

/**
 * Pull the app's config values for dev/test/deploy caches. Missing store or
 * config is NOT an error — a fresh app simply has no secrets yet.
 */
export async function pullAppSecretsCache(
  deployUrl: string,
  token: string,
  appId: string,
  configName: string,
): Promise<PulledSecretsCache | null> {
  try {
    const { secrets } = await fetchSecretsValues(deployUrl, token, appId, configName)
    // A wrong/broken service can answer 200 without the documented `secrets`
    // object (or with null); left unchecked `Object.keys(values)` downstream throws
    // a raw, uncoded `Cannot convert undefined or null to object` on the deploy
    // path. Code it invalid_response — the same slug the repo-API guard uses — so
    // the refresh fails closed with a real message instead of a leaked TypeError.
    if (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) {
      throw new ApiError(
        `The secrets service at ${deployUrl} returned an unexpected response shape — check DEEPSPACE_DEPLOY_URL (is this the service the app lives on?).`,
        200,
        'invalid_response',
        `/${appId}/configs/${configName}/values`,
      )
    }
    return { appId, configName, values: secrets }
  } catch (err) {
    // 404: no store yet, or no such config. Both mean "nothing to ship". Match
    // on the status field, not the message (which no longer carries the code).
    if ((err as { status?: number })?.status === 404) return null
    throw err
  }
}

// ── Cache rendering / parsing ────────────────────────────────────────────────

export function quoteDotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value) && value !== '') return value
  // Newlines must be escaped or the value's tail parses as extra env vars;
  // dotenv expands \n / \r inside double-quoted values.
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
  return `"${escaped}"`
}

/** Render pulled store values as the `.dev.vars` secrets block. The file's
 *  own header already says "generated, do not edit" — this line just names
 *  which store the values came from. */
export function renderSecretsCache(
  secrets: Record<string, string>,
  source: { appId: string; configName: string },
): string {
  const keys = Object.keys(secrets).sort()
  const lines = [`# App secrets · config ${source.configName} · app ${source.appId}`]
  for (const key of keys) {
    validateSecretValue(key, secrets[key])
    lines.push(`${key}=${quoteDotenvValue(secrets[key])}`)
  }
  return lines.join('\n')
}

// ── Upload/download formats (Doppler-compatible) ─────────────────────────────

export function parseSecretsUpload(content: string): Record<string, string> {
  const trimmed = content.trim()
  if (!trimmed) return {}
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON upload must be an object of KEY=value strings.')
    }
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      validateSecretName(key)
      if (typeof value !== 'string') throw new Error(`Secret "${key}" must be a string`)
      validateSecretValue(key, value)
      out[key] = value
    }
    return out
  }
  // dotenv — supports multiline quoted values (dotenv ≥15 semantics): a value
  // whose opening quote isn't closed on its own line continues, verbatim,
  // until a line ending with the closing quote. Without this, uploading a
  // .env holding a real PEM silently stored one byte and minted phantom keys
  // from the base64 continuation lines.
  const out: Record<string, string> = {}
  const lines = trimmed.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const lineNumber = i + 1
    const eq = line.indexOf('=')
    if (eq <= 0) {
      throw new Error(`Invalid dotenv assignment on line ${lineNumber}: expected KEY=value.`)
    }
    const key = line.slice(0, eq).trim()
    if (!SECRET_NAME_RE.test(key)) {
      throw new Error(
        `Invalid secret name on line ${lineNumber}: use letters, numbers, and underscores; ` +
          'start with a letter or underscore.',
      )
    }
    validateSecretName(key) // reject reserved/SDK-managed names with a clear message, same as `set`
    const raw = line.slice(eq + 1).trim()
    const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : null
    let value: string
    if (!quote) {
      value = raw
    } else if (endsWithUnescapedQuote(raw.slice(1), quote)) {
      const inner = raw.slice(1, -1)
      value = quote === '"' ? unescapeDotenv(inner) : inner
    } else {
      // Multiline: consume raw (untrimmed) lines until one closes the quote.
      const startLine = i + 1
      const parts = [raw.slice(1)]
      let closed = false
      while (++i < lines.length) {
        const cont = lines[i].trimEnd()
        if (endsWithUnescapedQuote(cont, quote)) {
          parts.push(cont.slice(0, -1))
          closed = true
          break
        }
        parts.push(lines[i])
      }
      if (!closed) {
        throw new Error(
          `Unterminated quoted value for "${key}" (opens on line ${startLine}). ` +
            `Close the ${quote === '"' ? 'double' : 'single'} quote, or escape newlines as \\n on one line.`,
        )
      }
      value = parts.join('\n')
      if (quote === '"') value = unescapeDotenv(value)
    }
    validateSecretValue(key, value)
    out[key] = value
  }
  return out
}

/** True when `s` is non-empty and ends with `q` not preceded by an odd run of
 *  backslashes (only `"` values support escapes; `'` closes unconditionally). */
function endsWithUnescapedQuote(s: string, q: string): boolean {
  if (!s.endsWith(q)) return false
  if (q === "'") return true
  let backslashes = 0
  for (let j = s.length - 2; j >= 0 && s[j] === '\\'; j--) backslashes++
  return backslashes % 2 === 0
}

/** Left-to-right so `\\n` (escaped backslash + n) isn't confused with `\n`. */
function unescapeDotenv(v: string): string {
  let out = ''
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) {
      const c = v[++i]
      out += c === 'n' ? '\n' : c === 'r' ? '\r' : c
    } else {
      out += v[i]
    }
  }
  return out
}

/**
 * POSIX single-quote: wrap in `'…'`, closing/reopening around any embedded
 * single quote (`'\''`). Unlike dotenv double-quoting, this preserves real
 * newlines literally, so `eval "$(… download --format shell)"` restores a
 * multiline value (e.g. a PEM key) byte-for-byte instead of a one-line `\n`.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function formatSecretsDownload(
  secrets: Record<string, string>,
  format: SecretsDownloadFormat,
): string {
  const entries = Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b))
  if (format === 'json') {
    return JSON.stringify(Object.fromEntries(entries), null, 2) + '\n'
  }
  if (format === 'shell') {
    return entries.map(([k, v]) => `export ${k}=${shellSingleQuote(v)}`).join('\n') + '\n'
  }
  return entries.map(([k, v]) => `${k}=${quoteDotenvValue(v)}`).join('\n') + '\n'
}

/**
 * The pull-and-render step every command shares (deploy/dev/test): fetch the
 * app's config values and render the generated `.dev.vars` cache section.
 * Missing configs still render an empty materialization so every successful
 * local refresh clears stale values. The nullable `pulled` field preserves
 * the separate deploy meaning: absent is not the same as intentionally empty.
 * Real failures (auth, 5xx) throw — callers cancel loudly.
 */
export async function refreshSecretsCache(
  deployUrl: string,
  token: string,
  appId: string,
  wranglerEnv: string | undefined,
  selectedConfigName: string = defaultConfigNameForEnv(wranglerEnv),
): Promise<RefreshedSecretsCache> {
  const configName = selectedConfigName
  const pulled = await pullAppSecretsCache(deployUrl, token, appId, configName)
  const values = pulled?.values ?? {}
  const count = Object.keys(values).length
  return {
    pulled,
    rendered: renderSecretsCache(values, { appId, configName }),
    // An empty store is the common case and not worth a status line.
    summary: count ? `Secrets: ${configName} (${count} secret${count === 1 ? '' : 's'})` : null,
  }
}
