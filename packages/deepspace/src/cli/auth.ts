/**
 * CLI auth utilities — shared across all commands.
 *
 * Reads the session token from ~/.deepspace/session and ensures
 * a fresh JWT is available at ~/.deepspace/token.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { PLATFORM_URLS } from './env'
import { decodeJwtPayload } from './jwt'
import { exchangeSession } from './session'
import { registerAuthRefresh } from './lib/api'
import { cliAction, Refusal } from './lib/command'

const AUTH_URL = process.env.DEEPSPACE_AUTH_URL ?? PLATFORM_URLS.auth
/** The plane whose credentials keep the historical un-suffixed filenames. */
const PROD_AUTH_URL = 'https://auth.deep.space'

const DIR = join(homedir(), '.deepspace')

/**
 * Credentials are stored PER AUTH PLANE.
 *
 * They used to be one global pair (`~/.deepspace/{session,token}`), so a
 * single `DEEPSPACE_ENV=staging` login silently clobbered the production
 * session — and the next prod command exchanged a staging cookie against the
 * prod auth worker and reported "Session expired. Run `deepspace auth
 * login`", which reads like a token-refresh failure but is actually a
 * different account plane. Auto-refresh was working the whole time.
 *
 * Keyed by the effective auth URL, because that (not DEEPSPACE_ENV alone) is
 * what decides who issued the cookie — a bare `DEEPSPACE_AUTH_URL` override
 * gets its own slot too. Production keeps the historical filenames, so
 * upgrading does not log anyone out.
 */
function credentialSuffix(authUrl: string): string {
  if (authUrl === PROD_AUTH_URL) return ''
  const host = (() => {
    try {
      return new URL(authUrl).host
    } catch {
      return authUrl
    }
  })()
  return `.${host.replace(/[^a-zA-Z0-9]+/g, '-')}`
}

/** The {session,token} file pair for a given auth plane. */
export function credentialPaths(authUrl: string = AUTH_URL): {
  sessionPath: string
  tokenPath: string
} {
  const suffix = credentialSuffix(authUrl)
  return { sessionPath: join(DIR, `session${suffix}`), tokenPath: join(DIR, `token${suffix}`) }
}

export const { sessionPath: SESSION_PATH, tokenPath: TOKEN_PATH } = credentialPaths()

/**
 * Ensure a valid JWT exists. Refreshes from the session token if expired.
 * Returns the JWT string or throws if not logged in / session expired.
 */
export async function ensureToken(): Promise<string> {
  // Try existing token first — if it's still valid, skip the refresh
  if (existsSync(TOKEN_PATH)) {
    const existing = readFileSync(TOKEN_PATH, 'utf-8').trim()
    if (isTokenValid(existing)) {
      return existing
    }
  }

  if (!existsSync(SESSION_PATH)) {
    throw new Refusal('Not logged in. Run `deepspace auth login` first.', 'not_authenticated', {
      action: cliAction('deepspace', 'auth', 'login'),
    })
  }

  const sessionToken = readFileSync(SESSION_PATH, 'utf-8').trim()

  // Refresh from session
  const token = await exchangeSession(AUTH_URL, sessionToken)
  if (!token) {
    throw new Refusal(
      'Session expired. Run `deepspace auth login` to re-authenticate.',
      'not_authenticated',
      { action: cliAction('deepspace', 'auth', 'login') },
    )
  }

  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 })

  return token
}

/** Check if a JWT has at least 30 seconds of validity remaining. */
function isTokenValid(jwt: string): boolean {
  try {
    const payload = decodeJwtPayload<{ exp?: number }>(jwt)
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now() + 30_000
  } catch {
    return false
  }
}

/**
 * Force-mint a fresh JWT from the stored session, ignoring the cached token
 * file — apiFetch's 401 recovery (see registerAuthRefresh). Never throws:
 * null means the session is gone/expired, and the caller's original 401
 * (with its own actionable message) is the right error to surface.
 */
registerAuthRefresh(async (): Promise<string | null> => {
  try {
    if (!existsSync(SESSION_PATH)) return null
    const sessionToken = readFileSync(SESSION_PATH, 'utf-8').trim()
    const token = await exchangeSession(AUTH_URL, sessionToken)
    if (!token) return null
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    writeFileSync(TOKEN_PATH, token, { mode: 0o600 })
    return token
  } catch {
    return null
  }
})
