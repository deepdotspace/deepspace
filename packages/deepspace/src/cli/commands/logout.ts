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

    if (sessionToken) {
      try {
        await fetch(`${AUTH_URL}/api/auth/sign-out`, {
          method: 'POST',
          headers: {
            Cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
            Origin: AUTH_URL,
          },
        })
      } catch {
        // Network failure — still wipe local credentials so the user can
        // re-authenticate. Server-side session will expire on its own.
      }
    }

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
