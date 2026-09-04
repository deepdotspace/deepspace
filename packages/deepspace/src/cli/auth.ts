/**
 * CLI auth utilities — shared across all commands.
 *
 * Reads the session token from ~/.deepspace/session and ensures
 * a fresh JWT is available at ~/.deepspace/token.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { AUTH_URL, DEEPSPACE_ENV, PLANE_AUTH_URLS } from './env'
import { decodeJwtPayload } from '../shared/jwt'
import { exchangeAgentSession, exchangeSession } from './session'
import { registerAuthRefresh } from './lib/api'
import { cliAction, Refusal } from './lib/command'
import type { CliAction } from './lib/output'
import { writeSecretFileSync } from './lib/secure-file'

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

function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/**
 * Read one local credential without confusing a missing login with a broken
 * credential store. `existsSync` cannot make that distinction reliably: a
 * permissions failure can look absent, and a file can disappear between the
 * existence check and the read.
 */
function readCredential(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8').trim()
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT') return null
    throw new Refusal(
      `Could not read the DeepSpace CLI credential at ${path}${code ? ` (${code})` : ''}. Fix the file or directory permissions, then retry.`,
      'credential_unreadable',
    )
  }
}

/** Persist a refreshed bearer, preserving local storage failures as such. */
function writeCachedToken(token: string): void {
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 })
    writeSecretFileSync(TOKEN_PATH, token)
  } catch (error) {
    const code = errnoCode(error)
    throw new Refusal(
      `Could not save the refreshed DeepSpace CLI token at ${TOKEN_PATH}${code ? ` (${code})` : ''}. Make ${DIR} writable and check available disk space, then retry.`,
      'credential_unwritable',
    )
  }
}

/**
 * Ensure a sufficiently long-lived JWT exists. Refreshes from the session
 * token when the cached bearer cannot cover the caller's expected work.
 * Returns the JWT string or throws if not logged in / session expired.
 */
export async function ensureToken(options: EnsureTokenOptions = {}): Promise<string> {
  const minimumValidityMs = options.minimumValidityMs ?? 30_000
  // Try existing token first — if it's still valid, skip the refresh
  const existing = readCredential(TOKEN_PATH)
  if (existing !== null && isTokenValid(existing, minimumValidityMs)) {
    return existing
  }

  const sessionToken = readCredential(SESSION_PATH)
  if (sessionToken === null) throw notAuthenticated('Not logged in')
  const token = await exchangeAndCacheSession(sessionToken)
  if (!token) throw notAuthenticated('The stored session is invalid')
  return token
}

/**
 * The `auth login` action every not_authenticated refusal ships — or none.
 * The bare action only succeeds interactively (browser login) or headless
 * with $DEEPSPACE_EMAIL + $DEEPSPACE_PASSWORD set; shipping it to a headless
 * caller without credentials pointed strict agents at a guaranteed
 * `interactive_required` refusal (AX C5, two lanes; docs/audits/2026-09-01).
 * Action argv may not carry placeholders, so when only the user can supply
 * credentials the contract's answer is NO action — the prose names the
 * headless form. One builder so the eleven refusal sites cannot drift.
 */
export function loginAction(): CliAction | undefined {
  const canRunBare =
    (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)) ||
    (Boolean(process.env.DEEPSPACE_EMAIL) && Boolean(process.env.DEEPSPACE_PASSWORD))
  return canRunBare ? cliAction('deepspace', 'auth', 'login') : undefined
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
    { action: loginAction() },
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
  const sessionToken = readCredential(SESSION_PATH)
  if (sessionToken === null) throw notAuthenticated('Not logged in')
  const token = await exchangeAgentSession(AUTH_URL, sessionToken, target)
  if (!token) throw notAuthenticated('The stored session is invalid')
  return token
}

async function exchangeStoredSession(): Promise<string | null> {
  const sessionToken = readCredential(SESSION_PATH)
  if (sessionToken === null) return null
  return await exchangeAndCacheSession(sessionToken)
}

async function exchangeAndCacheSession(sessionToken: string): Promise<string | null> {
  const token = await exchangeSession(AUTH_URL, sessionToken)
  if (!token) return null
  writeCachedToken(token)
  return token
}

/**
 * Force-mint a fresh JWT from the stored session, ignoring the cached token
 * file — apiFetch's 401 recovery (see registerAuthRefresh). Null means the
 * session is confirmed gone/expired; service and transport errors throw.
 */
registerAuthRefresh(refreshTokenFromSession)
