/**
 * CLI auth utilities — shared across all commands.
 *
 * Reads the session token from ~/.deepspace/session and ensures
 * a fresh JWT is available at ~/.deepspace/token.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { DEEPSPACE_ENV, PLANE_AUTH_URLS, PLATFORM_URLS } from './env'
import { decodeJwtPayload } from '../shared/jwt'
import { exchangeAgentSession, exchangeSession } from './session'
import { registerAuthRefresh } from './lib/api'
import { cliAction, Refusal } from './lib/command'
import { writeSecretFileSync } from './lib/secure-file'

const AUTH_URL = process.env.DEEPSPACE_AUTH_URL ?? PLATFORM_URLS.auth
/** The plane whose credentials keep the historical un-suffixed filenames. */
const PROD_AUTH_URL = PLANE_AUTH_URLS.production

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

export interface EnsureTokenOptions {
  /** Required remaining lifetime for a cached JWT. Defaults to 30 seconds. */
  minimumValidityMs?: number
}

/**
 * Ensure a sufficiently long-lived JWT exists. Refreshes from the session
 * token when the cached bearer cannot cover the caller's expected work.
 * Returns the JWT string or throws if not logged in / session expired.
 */
export async function ensureToken(options: EnsureTokenOptions = {}): Promise<string> {
  const minimumValidityMs = options.minimumValidityMs ?? 30_000
  // Try existing token first — if it's still valid, skip the refresh
  if (existsSync(TOKEN_PATH)) {
    const existing = readFileSync(TOKEN_PATH, 'utf-8').trim()
    if (isTokenValid(existing, minimumValidityMs)) {
      return existing
    }
  }

  if (!existsSync(SESSION_PATH)) throw notAuthenticated('Not logged in')

  const token = await exchangeStoredSession()
  if (!token)
    throw notAuthenticated('The stored session is no longer valid (expired or unreadable)')
  return token
}

/**
 * The ONE `not_authenticated` refusal. Credentials are per auth plane, so
 * "not logged in" is only half the truth whenever the selected plane is not
 * the one a stored session belongs to: `DEEPSPACE_ENV=staging` (or a
 * `DEEPSPACE_AUTH_URL` override) against a production login used to read
 * exactly like a plain logout — and the advertised recovery, `auth login`,
 * then logged the caller in on the WRONG plane. The sentence names the plane
 * this command selected, what selected it, and any other plane that does
 * hold a session; and it names the headless login form up front, because the
 * bare `auth login` action refuses `interactive_required` without a TTY.
 */
function notAuthenticated(state: string): Refusal {
  const selected =
    process.env.DEEPSPACE_AUTH_URL !== undefined
      ? `the auth service at ${AUTH_URL} (selected by DEEPSPACE_AUTH_URL)`
      : DEEPSPACE_ENV === 'production' && process.env.DEEPSPACE_ENV === undefined
        ? 'production'
        : `${DEEPSPACE_ENV} (selected by DEEPSPACE_ENV=${process.env.DEEPSPACE_ENV})`
  const elsewhere = Object.entries(PLANE_AUTH_URLS)
    .filter(([, url]) => url !== AUTH_URL && existsSync(credentialPaths(url).sessionPath))
    .map(([plane]) => plane)
  // How to select the plane that does hold a session: production is the
  // default (unset DEEPSPACE_ENV), any other plane is DEEPSPACE_ENV=<plane>,
  // and a URL override must go either way.
  const select = [
    ...(elsewhere[0] === 'production'
      ? process.env.DEEPSPACE_ENV !== undefined
        ? ['unset DEEPSPACE_ENV']
        : []
      : elsewhere[0]
        ? [`DEEPSPACE_ENV=${elsewhere[0]}`]
        : []),
    ...(process.env.DEEPSPACE_AUTH_URL !== undefined ? ['unset DEEPSPACE_AUTH_URL'] : []),
  ]
  const other =
    elsewhere.length > 0
      ? ` You are signed in on ${elsewhere.join(' and ')} — select that plane (${select.join(' and ')}), or log in here.`
      : ''
  return new Refusal(
    `${state} on ${selected}.${other} Run \`deepspace auth login\` (headless: ` +
      '`deepspace auth login --email you@example.com --password-stdin`, or set DEEPSPACE_EMAIL and DEEPSPACE_PASSWORD).',
    'not_authenticated',
    { action: cliAction('deepspace', 'auth', 'login') },
  )
}

/** Check if a JWT covers the caller's required remaining lifetime. */
function isTokenValid(jwt: string, minimumValidityMs: number): boolean {
  try {
    const payload = decodeJwtPayload<{ exp?: number }>(jwt)
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now() + minimumValidityMs
  } catch {
    return false
  }
}

/**
 * Force-mint and persist a fresh JWT from the stored long-lived session.
 * Null means there is no usable session. Auth-service failures retain their
 * coded error so a rejected bearer is never misreported as an expired login.
 */
export async function refreshTokenFromSession(): Promise<string | null> {
  return await exchangeStoredSession()
}

/**
 * Mint a target-bound agent token from the stored session without reading or
 * replacing the CLI's ordinary platform-token cache.
 */
export async function mintAgentToken(target: string): Promise<string> {
  if (!existsSync(SESSION_PATH)) throw notAuthenticated('Not logged in')
  const sessionToken = readFileSync(SESSION_PATH, 'utf-8').trim()
  const token = await exchangeAgentSession(AUTH_URL, sessionToken, target)
  if (!token)
    throw notAuthenticated('The stored session is no longer valid (expired or unreadable)')
  return token
}

async function exchangeStoredSession(): Promise<string | null> {
  if (!existsSync(SESSION_PATH)) return null
  const sessionToken = readFileSync(SESSION_PATH, 'utf-8').trim()
  const token = await exchangeSession(AUTH_URL, sessionToken)
  if (!token) return null
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  writeSecretFileSync(TOKEN_PATH, token)
  return token
}

/**
 * Force-mint a fresh JWT from the stored session, ignoring the cached token
 * file — apiFetch's 401 recovery (see registerAuthRefresh). Null means the
 * session is confirmed gone/expired; service and transport errors throw.
 */
registerAuthRefresh(refreshTokenFromSession)
