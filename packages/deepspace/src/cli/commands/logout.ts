/**
 * deepspace auth logout
 *
 * Revokes the session on the auth worker, then removes the cached session
 * token and JWT from ~/.deepspace/. Test accounts (managed by `deepspace
 * test-accounts`) are not touched.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope
 * and the exit code come from there. Logging out is TERMINAL — there is no
 * follow-up worth naming, so this command emits no `next` (the contract
 * forbids filler).
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'

import { AUTH_URL } from '../env'
import { SESSION_COOKIE } from '../session'
import { credentialPaths } from '../auth'
import { defineDeepspaceCommand } from '../lib/command'

// Per-plane paths from the shared helper — logging out of staging must not
// delete the production session (and vice versa).
const { sessionPath: SESSION_PATH, tokenPath: TOKEN_PATH } = credentialPaths(AUTH_URL)

/**
 * Revoke a session on the auth worker. Better Auth refuses a cookie-bearing
 * POST without a JSON body (415) and a trusted Origin (403), so both are sent.
 * Returns whether the session was revoked; network failures return false.
 */
export async function revokeSession(authUrl: string, sessionToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${authUrl}/api/auth/sign-out`, {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
        'Content-Type': 'application/json',
        Origin: authUrl,
      },
      body: '{}',
    })
    return response.ok
  } catch {
    return false
  }
}

export default defineDeepspaceCommand({
  meta: {
    name: 'logout',
    description: 'Sign out and remove cached credentials',
  },
  async run({ args }) {
    // Read the session token before deleting it so we can revoke server-side.
    const sessionToken = existsSync(SESSION_PATH)
      ? readFileSync(SESSION_PATH, 'utf-8').trim()
      : null

    // If revocation fails (for example, offline), still wipe local credentials
    // so the user can re-authenticate; the server-side session expires on its own.
    if (sessionToken) await revokeSession(AUTH_URL, sessionToken)

    let removed = 0
    for (const path of [SESSION_PATH, TOKEN_PATH]) {
      if (existsSync(path)) {
        rmSync(path)
        removed++
      }
    }

    // Already-logged-out is a SUCCESS, not a refusal: the requested end state
    // (no cached credentials) holds either way, so an agent retrying logout
    // must not read exit 1.
    if (!args.json) console.log(removed === 0 ? 'Already logged out.' : 'Logged out.')
    return { data: { loggedOut: true, removed, alreadyLoggedOut: removed === 0 } }
  },
})
