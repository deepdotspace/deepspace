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

import { ensureToken, loginAction } from '../auth'
import { DASHBOARD_URL } from '../env'
import { decodeJwtPayload } from '../../shared/jwt'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { readAgentCredential } from '../agent-credentials'

interface JwtPayload {
  sub?: string
  name?: string
  email?: string
  image?: string | null
  iss?: string
  iat?: number
  exp?: number
  agentAccount?: boolean
}

export default defineDeepspaceCommand({
  meta: { name: 'whoami', description: 'Show the currently logged-in user' },
  async run({ args }) {
    // Uncaught on purpose: ensureToken throws the plane-aware
    // `not_authenticated` refusal with the login action, and the session
    // exchange codes an unreachable auth server as `network_error` — so a
    // retry is never mistaken for a re-login, with no local classifier.
    const jwt = await ensureToken()

    let payload: JwtPayload
    try {
      payload = decodeJwtPayload<JwtPayload>(jwt)
    } catch {
      throw new Refusal(
        'Malformed session token. Run `deepspace auth login` again.',
        'not_authenticated',
        {
          action: loginAction(),
        },
      )
    }

    const isTestAccount = !!payload.email?.endsWith('@deepspace.test')
    const accountType: 'agent' | 'developer' | 'test-account' | 'unknown' =
      payload.agentAccount === true
        ? 'agent'
        : isTestAccount
          ? 'test-account'
          : payload.email
            ? 'developer'
            : 'unknown'
    const verifiedUntil =
      accountType === 'agent' ? (readAgentCredential()?.verifiedUntil ?? null) : null
    const renewalDueSoon =
      verifiedUntil !== null && Date.parse(verifiedUntil) - Date.now() <= 30 * 60_000

    if (!args.json) {
      console.log(`Name:       ${payload.name ?? '(none)'}`)
      console.log(`Email:      ${payload.email ?? '(none)'}`)
      // The raw user id identifies nobody a human can act on; it stays in
      // --json, where it is the stable machine handle.
      console.log(`Type:       ${accountType}`)
      if (payload.iss) console.log(`Issuer:     ${payload.iss}`)
      // Parity with --json's expiresAt: every fact the machine document
      // carries appears in the sentences too (2026-08-28 lifecycle AX F1).
      if (payload.exp) {
        console.log(`Expires:    ${new Date(payload.exp * 1000).toISOString()} (renews on use)`)
      }
      if (accountType === 'agent') {
        console.log(`Verified:   ${verifiedUntil ?? '(unknown)'}`)
        console.log('Renew:      deepspace auth agent renew --json (solve the returned challenge)')
        console.log('Identity:   Keep the account phrase in the private chat or private storage.')
      } else console.log(`Dashboard:  ${DASHBOARD_URL}`)
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
        ...(accountType === 'agent'
          ? {
              verifiedUntil,
              renewalDueSoon,
              renewalCommand: ['deepspace', 'auth', 'agent', 'renew', '--json'],
              credentialBackup:
                'Keep the account phrase in the private chat or private storage to restore access after this container disappears; losing all copies loses account access.',
            }
          : {}),
      },
    }
  },
})
