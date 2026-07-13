/**
 * deepspace whoami
 *
 * Shows the currently logged-in user. Auto-refreshes the JWT if expired.
 *
 * Prints all the identity fields a developer cares about (email, name,
 * userId, issuer) so you don't have to peek into ~/.deepspace/token.
 * Also flags whether the session is for a test account (`@deepspace.test`
 * email), since that's a meaningful distinction for who can do what — see
 * docs/auth/dev-vs-test-accounts.md.
 *
 * `--json` emits a parseable single-line JSON object for scripts.
 */

import { defineCommand } from 'citty'
import { ensureToken } from '../auth'
import { DASHBOARD_URL } from '../env'
import { decodeJwtPayload } from '../jwt'

interface JwtPayload {
  sub?: string
  name?: string
  email?: string
  image?: string | null
  iss?: string
  iat?: number
  exp?: number
}

export default defineCommand({
  meta: {
    name: 'whoami',
    description: 'Show the currently logged-in user',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit a single-line JSON object instead of human output',
      default: false,
    },
  },
  async run({ args }) {
    // A logged-out / malformed-session exit must honor --json so a consumer
    // parsing stdout gets a JSON error object, not a bare sentence, and both
    // paths exit non-zero (ONB-6).
    const failLoggedOut = (msg: string): never => {
      if (args.json) console.log(JSON.stringify({ loggedIn: false, error: msg }))
      else console.error(msg)
      process.exit(1)
    }

    // Definite-assignment: failLoggedOut() exits, so jwt is always set here.
    let jwt!: string
    try {
      jwt = await ensureToken()
    } catch (err: unknown) {
      failLoggedOut(err instanceof Error ? err.message : 'Not logged in. Run `deepspace login` first.')
    }

    // Definite-assignment: failLoggedOut() exits, so payload is always set here.
    let payload!: JwtPayload
    try {
      payload = decodeJwtPayload<JwtPayload>(jwt)
    } catch {
      failLoggedOut('Malformed session token. Run `deepspace login` again.')
    }

    const isTestAccount = !!payload.email?.endsWith('@deepspace.test')
    const accountType: 'developer' | 'test-account' | 'unknown' = isTestAccount
      ? 'test-account'
      : payload.email
        ? 'developer'
        : 'unknown'

    if (args.json) {
      console.log(JSON.stringify({
        loggedIn: true,
        name: payload.name ?? null,
        email: payload.email ?? null,
        userId: payload.sub ?? null,
        accountType,
        issuer: payload.iss ?? null,
        expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      }))
      return
    }

    console.log(`Name:       ${payload.name ?? '(none)'}`)
    console.log(`Email:      ${payload.email ?? '(none)'}`)
    console.log(`UserID:     ${payload.sub ?? '(none)'}`)
    console.log(`Type:       ${accountType}`)
    if (payload.iss) console.log(`Issuer:     ${payload.iss}`)
    console.log(`Dashboard:  ${DASHBOARD_URL}`)
    if (isTestAccount) {
      console.log('')
      console.log('Note: this is a test account, not a real OAuth developer.')
      console.log('See docs/auth/dev-vs-test-accounts.md.')
    }
  },
})
