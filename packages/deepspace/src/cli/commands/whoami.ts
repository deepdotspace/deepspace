/**
 * deepspace auth whoami
 *
 * Shows the currently logged-in user. Auto-refreshes the JWT if expired.
 *
 * Prints all the identity fields a developer cares about (email, name,
 * userId, issuer) so you don't have to peek into ~/.deepspace/token.
 * Also flags whether the session is for a test account (`@deepspace.test`
 * email), since that's a meaningful distinction for who can do what — see
 * docs/auth/dev-vs-test-accounts.md.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, and the exit codes come from there, not from this file.
 */

import { ensureToken } from '../auth'
import { DASHBOARD_URL } from '../env'
import { decodeJwtPayload } from '../../shared/jwt'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'

interface JwtPayload {
  sub?: string
  name?: string
  email?: string
  image?: string | null
  iss?: string
  iat?: number
  exp?: number
}

/**
 * A network failure reaching the auth server (Node fetch throws
 * `TypeError: fetch failed`, or a DNS/socket errno) is NOT proof of being
 * logged out — code it apart so a retry isn't mistaken for a re-login.
 */
const isNetworkError = (err: unknown): boolean =>
  err instanceof TypeError ||
  (err instanceof Error &&
    /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network/i.test(err.message))

export default defineDeepspaceCommand({
  meta: { name: 'whoami', description: 'Show the currently logged-in user' },
  async run({ args }) {
    let jwt: string
    try {
      jwt = await ensureToken()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Not logged in. Run `deepspace auth login` first.'
      // The code distinguishes a genuine logged-out state (log in) from an
      // unreachable auth server (retry): both would otherwise read as
      // "not logged in", and an agent would re-login instead of reconnecting.
      throw isNetworkError(err)
        ? new Refusal(msg, 'network_error')
        : new Refusal(msg, 'not_authenticated', {
            action: cliAction('deepspace', 'auth', 'login'),
          })
    }

    let payload: JwtPayload
    try {
      payload = decodeJwtPayload<JwtPayload>(jwt)
    } catch {
      throw new Refusal('Malformed session token. Run `deepspace auth login` again.', 'not_authenticated', {
        action: cliAction('deepspace', 'auth', 'login'),
      })
    }

    const isTestAccount = !!payload.email?.endsWith('@deepspace.test')
    const accountType: 'developer' | 'test-account' | 'unknown' = isTestAccount
      ? 'test-account'
      : payload.email
        ? 'developer'
        : 'unknown'

    if (!args.json) {
      console.log(`Name:       ${payload.name ?? '(none)'}`)
      console.log(`Email:      ${payload.email ?? '(none)'}`)
      // The raw user id identifies nobody a human can act on; it stays in
      // --json, where it is the stable machine handle.
      console.log(`Type:       ${accountType}`)
      if (payload.iss) console.log(`Issuer:     ${payload.iss}`)
      console.log(`Dashboard:  ${DASHBOARD_URL}`)
      if (isTestAccount) {
        console.log('')
        console.log('Note: this is a test account, not a real OAuth developer.')
        console.log('See docs/auth/dev-vs-test-accounts.md.')
      }
    }

    return {
      data: {
        name: payload.name ?? null,
        email: payload.email ?? null,
        userId: payload.sub ?? null,
        accountType,
        issuer: payload.iss ?? null,
        expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      },
    }
  },
})
