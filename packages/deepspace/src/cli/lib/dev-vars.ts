/** Local `.dev.vars` parsing, preservation, and SDK-managed writes. */

import { existsSync, readFileSync } from 'node:fs'
import { PLATFORM_URLS } from '../env'
import { readAppId } from './app-identity'
import { fetchAppIdentityToken, fetchPublicKey, mintAppOwnerJwt } from './app-tokens'
import { stripGeneratedSecretsCache } from './secrets'
import { writeSecretFileSync } from './secure-file'
import { devVarsPathFor } from './wrangler-env'

/** Keys rewritten from platform truth on every dev, test, and deploy run. */
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

export const DEV_VARS_DIVIDER = '# --- not managed by the SDK; preserved across dev/test runs ---'

interface WriteDevVarsOptions {
  appId?: string
  /** Rendered remote secrets cache, which replaces legacy preserved values. */
  generatedSecretsCache?: string
  /** Linked configs share `.dev.vars`; unlinked apps use `.dev.vars.<env>`. */
  sharedDevVarsCache?: boolean
}

/**
 * Strip SDK-managed lines above the divider while preserving all other content
 * verbatim, including comments and multi-line quoted values.
 */
export function extractCustomDevVars(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let belowDivider = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === DEV_VARS_DIVIDER.trim()) {
      belowDivider = true
      i++
      continue
    }
    const eq = line.indexOf('=')
    const keyMatch = eq >= 0 ? line.slice(0, eq).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/) : null
    if (!keyMatch) {
      out.push(line)
      i++
      continue
    }
    const key = keyMatch[1]
    const valueStart = line.slice(eq + 1)
    const block: string[] = [line]
    if (valueStart.startsWith('"') && !hasUnescapedQuote(valueStart.slice(1))) {
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
    if (belowDivider || !SDK_MANAGED_KEYS.has(key)) out.push(...block)
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out.join('\n')
}

function hasUnescapedQuote(value: string): boolean {
  let escaped = false
  for (const char of value) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') return true
  }
  return false
}

/** Parse values used by deploy safety checks from a dotenv-formatted string. */
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

    if (value.startsWith('"') && !closed) {
      throw new Error(
        `parseDevVars: unterminated quoted value for key "${key}" — check your .dev.vars file for a missing closing quote.`,
      )
    }
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
    const char = value[i]
    if (char !== '\\' || i === value.length - 1) {
      out += char
      continue
    }
    const next = value[i + 1]
    if (next === '\\' || next === '"') {
      out += next
      i++
      continue
    }
    out += char
  }
  return out
}

function requireAppIdFor(appDir: string, wranglerEnv?: string): string {
  const id = readAppId(appDir, wranglerEnv)
  if (id) return id
  throw new Error(
    'wrangler.toml has no DEEPSPACE_APP_ID' +
      (wranglerEnv ? ` for [env.${wranglerEnv}]` : '') +
      '. Run `deepspace app init` (or `deepspace app init --env <name>`) and retry.',
  )
}

/** Rewrite the SDK section and preserve user-owned values below it. */
export async function writeDevVars(
  appDir: string,
  ownerId: string,
  callerJwt: string,
  wranglerEnv?: string,
  opts: WriteDevVarsOptions = {},
): Promise<void> {
  const urls = PLATFORM_URLS
  const publicKey = await fetchPublicKey(urls.auth)
  const appId = opts.appId ?? requireAppIdFor(appDir, wranglerEnv)
  const appOwnerJwt = await mintAppOwnerJwt(urls.auth, callerJwt, appId)
  const appIdentityToken = await fetchAppIdentityToken(urls.deploy, callerJwt, appId)

  // Wrangler requires quotes around multi-line PEM values.
  const sdkVars = [
    `AUTH_JWT_PUBLIC_KEY="${publicKey}"`,
    `AUTH_JWT_ISSUER=${urls.auth}/api/auth`,
    `AUTH_WORKER_URL=${urls.auth}`,
    `API_WORKER_URL=${urls.api}`,
    `PLATFORM_WORKER_URL=${urls.platform}`,
    `OWNER_USER_ID=${ownerId}`,
    `APP_OWNER_JWT=${appOwnerJwt}`,
    ...(appIdentityToken ? [`APP_IDENTITY_TOKEN=${appIdentityToken}`] : []),
    `ALLOW_DEBUG_ROUTES=true`,
  ].join('\n')

  const useSharedDevVarsCache = opts.sharedDevVarsCache ?? opts.generatedSecretsCache !== undefined
  const devVarsPath = devVarsPathFor(appDir, wranglerEnv, {
    sharedDevVarsCache: useSharedDevVarsCache,
  })
  const existing = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf-8') : ''
  const custom =
    opts.generatedSecretsCache ??
    extractCustomDevVars(stripGeneratedSecretsCache(existing).trimEnd())
  let body: string
  if (!custom) {
    body = `${sdkVars}\n`
  } else if (opts.generatedSecretsCache) {
    body = `${sdkVars}\n\n${custom}\n`
  } else {
    body = `${sdkVars}\n\n${DEV_VARS_DIVIDER}\n${custom}\n`
  }

  writeSecretFileSync(devVarsPath, body)
}
