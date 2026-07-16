/**
 * Manage app collaborators: users you authorize to deploy your app on your
 * behalf. A collaborator just runs `deepspace deploy`; the deploy keeps your
 * identity and billing. Collaborators have owner-equivalent deploy access, so
 * only add people you trust.
 */

import { defineCommand } from 'citty'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { resolveAppTarget } from '../lib/app-context'
import { apiFetch } from '../lib/api'
import { isTestAccountEmail } from '../../server/auth/testAccounts'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api
const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

interface Collaborator {
  userId: string
  emailDisplay: string
  createdAt: string | number
}

interface PendingInvite {
  email: string
  /** Epoch milliseconds. */
  expiresAt: number
  invitedAt: number
}

type AddResponse =
  | { status: 'added'; collaborator: Collaborator }
  | { status: 'invited'; email: string; token: string; expiresAt: number }
  // A live invite already existed → the server did NOT re-charge or re-send.
  | { status: 'already_invited'; email: string; token: string; expiresAt: number }

function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>(API_URL, token, path, init)
}

const list = defineCommand({
  meta: { name: 'list', description: 'List collaborators on your app' },
  args: {
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app)
    const { collaborators, pending = [] } = await api<{
      collaborators: Collaborator[]
      pending?: PendingInvite[]
    }>(token, `/api/app-collaborators/${encodeURIComponent(app)}`)
    if (args.json) {
      process.stdout.write(JSON.stringify({ collaborators, pending }, null, 2) + '\n')
      return
    }
    if (!collaborators.length && !pending.length) {
      console.log(`No collaborators on ${app}. Add one with \`deepspace collaborators add <email>\`.`)
      return
    }
    // COL-4: print a header and the resolved email (emailDisplay). The raw
    // userId is dropped from the human view — it's still in --json, a human
    // reads the email, and `collaborators remove <email>` matches on it.
    if (collaborators.length) {
      console.log(`COLLABORATORS ON ${app}`)
      for (const c of collaborators) {
        console.log(`  ${c.emailDisplay}`)
      }
    }
    if (pending.length) {
      console.log(`PENDING INVITES ON ${app}`)
      for (const p of pending) {
        console.log(`  ${p.email} (expires ${new Date(p.expiresAt).toLocaleDateString()})`)
      }
    }
  },
})

const add = defineCommand({
  meta: { name: 'add', description: 'Authorize someone to deploy your app' },
  args: {
    email: {
      type: 'positional',
      description: 'Collaborator email',
      required: true,
    },
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app)
    if (isTestAccountEmail(args.email)) {
      console.error(
        'Test accounts (@deepspace.test) cannot be added as collaborators. Use a real DeepSpace account.',
      )
      process.exit(1)
    }
    // Failure slugs (insufficient_credits, test_account_cannot_be_collaborator,
    // ...) are translated centrally by wrapCommandErrors — just let them escape.
    // An email with no DeepSpace user is no longer an error: the server creates
    // a pending invite ({status:'invited'}) and emails the person.
    const res = await api<AddResponse>(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}`,
      { method: 'POST', body: JSON.stringify({ email: args.email }) },
    )
    if (args.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n')
      return
    }
    if (res.status === 'invited' || res.status === 'already_invited') {
      const expires = new Date(res.expiresAt).toLocaleDateString()
      if (res.status === 'already_invited') {
        console.log(
          `• ${res.email} already has a pending invite (expires ${expires}). ` +
            `No new email was sent. Cancel it with \`deepspace collaborators cancel ${res.email}\` to reset.`,
        )
        return
      }
      console.log(
        `✓ Invite sent to ${res.email} (expires ${expires}). ` +
          `They become a collaborator when they sign in.`,
      )
      return
    }
    console.log(`✓ ${res.collaborator.emailDisplay} can now deploy ${app}`)
  },
})

const remove = defineCommand({
  meta: { name: 'remove', description: 'Remove a collaborator from your app' },
  args: {
    email: { type: 'positional', description: 'Collaborator email', required: true },
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app)
    const { collaborators } = await api<{ collaborators: Collaborator[] }>(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}`,
    )
    const target = args.email.trim().toLowerCase()
    const found = collaborators.find((c) => c.emailDisplay.toLowerCase() === target)
    if (!found) {
      console.error(`${args.email} is not a collaborator on ${app}`)
      process.exit(1)
    }
    await api(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}/${encodeURIComponent(found.userId)}`,
      { method: 'DELETE' },
    )
    if (args.json) {
      process.stdout.write(JSON.stringify({ removed: found }, null, 2) + '\n')
      return
    }
    console.log(`✓ ${found.emailDisplay} can no longer deploy ${app}`)
  },
})

const cancel = defineCommand({
  meta: { name: 'cancel', description: 'Cancel a pending (un-accepted) email invite' },
  args: {
    email: { type: 'positional', description: 'Invited email', required: true },
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
    json: { type: 'boolean', description: 'Emit JSON' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app)
    // Match against the pending list (mirrors `remove`) so we can tell the user
    // when there's nothing to cancel rather than silently no-op'ing the DELETE.
    const { pending = [] } = await api<{ pending?: PendingInvite[] }>(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}`,
    )
    const target = args.email.trim().toLowerCase()
    const found = pending.find((p) => p.email.toLowerCase() === target)
    if (!found) {
      console.error(`${args.email} has no pending invite on ${app}`)
      process.exit(1)
    }
    await api(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}/pending/${encodeURIComponent(found.email)}`,
      { method: 'DELETE' },
    )
    if (args.json) {
      process.stdout.write(JSON.stringify({ cancelled: found }, null, 2) + '\n')
      return
    }
    console.log(`✓ Cancelled the pending invite to ${found.email} on ${app}`)
  },
})

// No `run()` on the parent: citty otherwise cascades it after each subcommand,
// printing spurious help text.
export default defineCommand({
  meta: { name: 'collaborators', description: 'Manage who can deploy your app' },
  subCommands: { list, add, remove, cancel },
})
