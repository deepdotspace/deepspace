/**
 * deepspace logout
 *
 * Revokes the session on the auth worker, then removes the cached session
 * token and JWT from ~/.deepspace/. Test accounts (managed by `deepspace
 * test-accounts`) are not touched.
 */

import { defineCommand } from 'citty'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { PLATFORM_URLS } from '../env'
import { SESSION_COOKIE } from '../session'

const AUTH_URL = process.env.DEEPSPACE_AUTH_URL ?? PLATFORM_URLS.auth

const DIR = join(homedir(), '.deepspace')
const SESSION_PATH = join(DIR, 'session')
const TOKEN_PATH = join(DIR, 'token')

export default defineCommand({
  meta: {
    name: 'logout',
    description: 'Sign out and remove cached credentials',
  },
  async run() {
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

    if (removed === 0) {
      console.log('Already logged out.')
      return
    }
    console.log('Logged out.')
  },
})
