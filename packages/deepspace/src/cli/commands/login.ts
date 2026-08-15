/**
 * deepspace auth login
 *
 * Opens the browser to sign in with GitHub or Google.
 * CLI polls the auth worker until login is complete.
 *
 *   deepspace auth login                          # browser-based OAuth
 *   deepspace auth login --email x --password y   # non-interactive (discouraged: argv leaks)
 *   echo "$PW" | deepspace auth login --email x --password-stdin   # password via stdin
 *   DEEPSPACE_EMAIL=x DEEPSPACE_PASSWORD=y deepspace auth login    # via env
 *
 * `--json` (from the command runtime, lib/command.ts) matters more here than
 * anywhere else: login is the FIRST command an agent runs, and until now it
 * had no machine surface at all. Two rules keep it usable:
 *
 *   1. `--json` is an explicit machine signal, so it also means "non-
 *      interactive" for credential resolution — $DEEPSPACE_EMAIL/$DEEPSPACE_
 *      PASSWORD are consulted even from a pty. (The guard against ambient
 *      DEEPSPACE_* hijacking a HUMAN `deepspace auth login` is untouched: a
 *      human doesn't pass --json.)
 *   2. The browser flow polls for up to TEN MINUTES. Entering it from a
 *      machine caller with nowhere to click is a silent hang, so `--json`
 *      without credentials and without a TTY refuses immediately
 *      (`interactive_required`) instead.
 */

import { credentialPaths } from '../auth'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import * as p from '@clack/prompts'

import { createSpinner } from '../lib/spinner'
import { DASHBOARD_URL, PLATFORM_URLS } from '../env'
import { exchangeSession, SESSION_COOKIE } from '../session'
import { decodeJwtPayload } from '../../shared/jwt'
import { openBrowser } from '../lib/open-browser'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'
import { writeSecretFileSync } from '../lib/secure-file'

const AUTH_URL = process.env.DEEPSPACE_AUTH_URL ?? PLATFORM_URLS.auth
const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api

export default defineDeepspaceCommand({
  meta: {
    name: 'login',
    description: 'Log in to your DeepSpace account',
  },
  args: {
    email: {
      type: 'string',
      description: 'Email address (non-interactive mode; or $DEEPSPACE_EMAIL)',
      required: false,
    },
    password: {
      type: 'string',
      description:
        'Password (discouraged — visible in ps/history; prefer --password-stdin or $DEEPSPACE_PASSWORD)',
      required: false,
    },
    'password-stdin': {
      type: 'boolean',
      description: 'Read the password from stdin instead of --password',
      default: false,
    },
  },
  async run({ args }) {
    const json = args.json
    // Non-interactive mode for CI/agents. Password from --password-stdin
    // (safest), $DEEPSPACE_PASSWORD, or --password (discouraged — visible in
    // `ps`/shell history); email from --email or $DEEPSPACE_EMAIL. The env vars
    // are consulted ONLY when stdin is non-interactive (or --json was asked
    // for), so ambient DEEPSPACE_* in a dev shell can't hijack an interactive
    // `deepspace auth login` into a password login as a different identity.
    const interactive = Boolean(process.stdin.isTTY) && !json
    const { email, password } = resolveLoginCredentials({
      emailArg: args.email as string | undefined,
      passwordArg: args.password as string | undefined,
      envEmail: interactive ? undefined : process.env.DEEPSPACE_EMAIL,
      envPassword: interactive ? undefined : process.env.DEEPSPACE_PASSWORD,
      passwordStdin: args['password-stdin'] ? readPasswordFromStdin() : undefined,
    })
    const passwordIntent =
      Boolean(args['password-stdin']) || args.password !== undefined || password !== undefined

    const decision = loginModeDecision({ email, password, passwordIntent })
    if (decision.mode === 'error') {
      throw new Refusal(decision.message, decision.code)
    }
    if (decision.mode === 'password') {
      if (!json) console.log(`Signing in as ${email}...`)
      const who = await doEmailLogin(email as string, password as string)
      if (!json) {
        console.log(`Logged in as ${who.email} (${who.userId})`)
        console.log(`Dashboard: ${DASHBOARD_URL}`)
      }
      return { data: { email: who.email, userId: who.userId } }
    }
    // decision.mode === 'oauth' → fall through to the browser flow below.

    // The browser flow polls for up to ten minutes. --json is the machine
    // signal on its own — a caller running under a pty (stdout IS a TTY) would
    // otherwise fall through and hang for ten minutes. Refuse for ANY --json
    // caller, or any non-TTY, with the flags that actually work.
    if (json || !process.stdout.isTTY) {
      throw new Refusal(
        'Browser login needs an interactive terminal. Use --email with --password-stdin (or $DEEPSPACE_EMAIL/$DEEPSPACE_PASSWORD).',
        'interactive_required',
      )
    }

    // Browser-based OAuth flow
    if (!json) p.intro('DeepSpace Login')

    const s = createSpinner()
    if (!json) s.start('Creating login session...')

    // PKCE: generate a random verifier and send only its SHA-256 hash to the
    // server. The verifier never leaves this process, so the loginUrl alone
    // can't be used to drain credentials at /status — only this CLI can.
    const codeVerifier = base64url(randomBytes(32))
    const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest())

    // 1. Create a CLI session
    const sessionRes = await fetch(`${AUTH_URL}/api/auth/cli/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code_challenge: codeChallenge }),
    })
    // The runtime stops any live spinner before it renders a refusal, so these
    // throws don't need to unwind the spinner themselves.
    if (!sessionRes.ok) {
      throw new Refusal(
        `Could not create login session (${sessionRes.status})`,
        'login_session_failed',
        { action: cliAction('deepspace', 'auth', 'login') },
      )
    }
    const sessionData = (await sessionRes.json()) as {
      sessionId?: string
      loginUrl?: string
    }
    if (!sessionData.sessionId || !sessionData.loginUrl) {
      throw new Refusal(
        'Could not create login session — the auth server returned no session id or login url.',
        'login_session_failed',
        { action: cliAction('deepspace', 'auth', 'login') },
      )
    }

    const { sessionId, loginUrl } = sessionData as {
      sessionId: string
      loginUrl: string
    }

    if (!json) {
      s.stop('Opening browser...')
      p.log.info(`If the browser doesn't open, visit:\n  ${loginUrl}`)
    }

    // 2. Open browser
    openBrowser(loginUrl)

    // 3. Poll for completion
    if (!json) s.start('Waiting for authentication...')
    const result = await pollForCompletion(sessionId, codeVerifier)

    if (!result) {
      throw new Refusal(
        'Login timed out. Run `deepspace auth login` to try again.',
        'login_timeout',
        {
          action: cliAction('deepspace', 'auth', 'login'),
        },
      )
    }

    // 4. Store credentials + provision the billing profile (see provisionProfile)
    storeCredentials(result.sessionToken, result.jwt)
    await provisionProfile(result.jwt)

    // Report the same identity fields the password path does, so an agent
    // never has to follow login with `whoami` to learn who it became.
    let userId = '(unknown)'
    try {
      userId = decodeJwtPayload<{ sub?: string }>(result.jwt).sub ?? userId
    } catch {
      // A malformed JWT is the session's problem, not login's — keep going.
    }

    if (!json) {
      s.stop('Authenticated')
      p.log.success(`Logged in as ${result.name ?? result.email}`)
      p.note(
        `Manage your account, deployed apps, billing, and subscription\nplans on the web dashboard:\n\n  ${DASHBOARD_URL}`,
        'Dashboard',
      )
      p.outro('Done')
    }
    return { data: { email: result.email, userId } }
  },
})

/**
 * Resolve non-interactive login credentials with a clear precedence (ONB-4):
 * email = --email > $DEEPSPACE_EMAIL; password = --password-stdin (when the flag
 * is set, its already-read value wins) > --password > $DEEPSPACE_PASSWORD.
 * Pure for testing.
 */
export function resolveLoginCredentials(opts: {
  emailArg?: string
  passwordArg?: string
  envEmail?: string
  envPassword?: string
  passwordStdin?: string
}): { email?: string; password?: string } {
  const email = opts.emailArg || opts.envEmail || undefined
  const password =
    opts.passwordStdin !== undefined
      ? opts.passwordStdin
      : opts.passwordArg || opts.envPassword || undefined
  return { email, password }
}

/**
 * Decide how `login` should proceed given the resolved credentials (ONB-4).
 * `passwordIntent` is true when the user asked for a password login (a
 * credential flag/stdin or a resolved password). Crucially, a supplied-but-
 * incomplete credential set (missing email, or an EMPTY password — e.g. an
 * empty `--password-stdin` in CI) becomes an `error`, not a silent fall-through
 * to the browser OAuth flow (which would hang ~10 min in a headless pipeline).
 * `code` is the machine slug the refusal carries. Pure for testing.
 */
export function loginModeDecision(opts: {
  email?: string
  password?: string
  passwordIntent: boolean
}): { mode: 'password' } | { mode: 'oauth' } | { mode: 'error'; message: string; code: string } {
  if (opts.email && opts.password) return { mode: 'password' }
  if (!opts.passwordIntent) return { mode: 'oauth' }
  if (!opts.email) {
    return {
      mode: 'error',
      code: 'missing_email',
      message:
        'Non-interactive login needs an email: --email <you@example.com> (or $DEEPSPACE_EMAIL).',
    }
  }
  return {
    mode: 'error',
    code: 'missing_password',
    message:
      'Non-interactive login needs a non-empty password: --password-stdin, $DEEPSPACE_PASSWORD, or --password.',
  }
}

/**
 * Read a password piped on stdin (one trailing newline stripped). Refuses on a
 * TTY, where reading stdin would block forever waiting for EOF.
 */
function readPasswordFromStdin(): string {
  if (process.stdin.isTTY) {
    throw new Refusal(
      '--password-stdin expects the password piped on stdin, e.g. `printf %s "$PW" | deepspace auth login --email you@x.com --password-stdin`.',
      'password_stdin_needs_pipe',
    )
  }
  return readFileSync(0, 'utf-8').replace(/\r?\n$/, '')
}

interface LoginResult {
  sessionToken: string
  jwt: string
  email: string
  name: string | null
}

async function pollForCompletion(
  sessionId: string,
  codeVerifier: string,
): Promise<LoginResult | null> {
  const maxAttempts = 120 // 10 minutes at 5s intervals
  const interval = 5000

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(interval)

    try {
      const res = await fetch(`${AUTH_URL}/api/auth/cli/status/${sessionId}`, {
        headers: { 'x-code-verifier': codeVerifier },
      })

      if (res.status === 410 || res.status === 404) return null // expired / not found
      if (!res.ok) continue

      const data = (await res.json()) as {
        state?: string
        sessionToken?: string
        jwt?: string
        email?: string
        name?: string
      }

      if (data.state === 'complete' && data.sessionToken && data.jwt) {
        return {
          sessionToken: data.sessionToken,
          jwt: data.jwt,
          email: data.email ?? '',
          name: data.name ?? null,
        }
      }
    } catch {
      // Network error, keep polling
    }
  }

  return null
}

function storeCredentials(sessionToken: string, jwt: string) {
  // Per-plane paths: a staging login must not overwrite the production
  // session (that clobber surfaced as a bogus "Session expired" on the next
  // prod command).
  const { sessionPath, tokenPath } = credentialPaths(AUTH_URL)
  mkdirSync(dirname(sessionPath), { recursive: true, mode: 0o700 })
  writeSecretFileSync(sessionPath, sessionToken)
  writeSecretFileSync(tokenPath, jwt)
}

/**
 * Provision the user's billing profile so they can be referenced by email
 * immediately after logging in — e.g. added as a collaborator on someone
 * else's app. The api-worker's auth middleware upserts the `userProfiles`
 * row on any authenticated call, but login/whoami only ever touch the auth
 * worker, so a fresh CLI-only account otherwise has no profile and
 * `collaborators add <their-email>` 404s until their first deploy. One GET
 * to /api/users/me creates it. Best-effort: the same upsert happens on any
 * later api-worker call, so a transient failure here must not fail login.
 */
async function provisionProfile(jwt: string): Promise<void> {
  try {
    await fetch(`${API_URL}/api/users/me`, { headers: { Authorization: `Bearer ${jwt}` } })
  } catch {
    // non-fatal — the profile is upserted on the next api-worker request
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── Email/password login (for test accounts and CI) ────────────────

async function doEmailLogin(
  email: string,
  password: string,
): Promise<{ email: string; userId: string }> {
  const res = await fetch(`${AUTH_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: AUTH_URL },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    throw new Error(body.message ?? `Authentication failed (${res.status})`)
  }

  const setCookie = res.headers.get('set-cookie') ?? ''
  const cookieMatch = setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))
  if (!cookieMatch) {
    throw new Error('No session cookie returned')
  }
  const sessionToken = decodeURIComponent(cookieMatch[1])

  const jwt = await exchangeSession(AUTH_URL, sessionToken)
  if (!jwt) {
    throw new Error('JWT issuance failed')
  }

  storeCredentials(sessionToken, jwt)
  await provisionProfile(jwt)
  // The user id is the fact `whoami --json` reports as `userId`; surface it at
  // login too so an agent never has to re-run whoami to learn who it became.
  let userId = '(unknown)'
  try {
    userId = decodeJwtPayload<{ sub?: string }>(jwt).sub ?? userId
  } catch {
    // A malformed JWT is the session's problem, not login's — keep going.
  }
  return { email, userId }
}
