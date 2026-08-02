/**
 * Manage app collaborators: users you authorize to deploy your app on your
 * behalf. A collaborator just runs `deepspace deploy`; the deploy keeps your
 * identity and billing. Collaborators have owner-equivalent deploy access, so
 * only add people you trust.
 *
 * Defined with the command runtime (lib/command.ts): `--json` (now a
 * single-line `{ ok, … }` envelope instead of each subcommand's own
 * pretty-printed blob), the slug, the `Next:` line and the exit codes come
 * from there. No subcommand prompts — `remove`/`cancel` refuse an unknown
 * target rather than asking.
 */

import { defineCommand } from 'citty'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { resolveAppTarget } from '../lib/app-target'
import { apiFetch } from '../lib/api'
import { isTestAccountEmail } from '../../server/auth/testAccounts'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'

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

const list = defineDeepspaceCommand({
  meta: { name: 'list', description: 'List collaborators on your app' },
  args: {
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app as string | undefined)
    const { collaborators, pending = [] } = await api<{
      collaborators: Collaborator[]
      pending?: PendingInvite[]
    }>(token, `/api/app-collaborators/${encodeURIComponent(app)}`)
    if (!collaborators.length && !pending.length) {
      if (!args.json) {
        console.log(`No collaborators on ${app}. Add one with \`deepspace app collaborators add <email>\`.`)
      }
      return { data: { collaborators, pending } }
    }
    // COL-4: print a header and the resolved email (emailDisplay). The raw
    // userId is dropped from the human view — it's still in --json, a human
    // reads the email, and `collaborators remove <email>` matches on it.
    if (!args.json) {
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
    }
    return { data: { collaborators, pending } }
  },
})

const add = defineDeepspaceCommand({
  meta: { name: 'add', description: 'Authorize someone to deploy your app' },
  args: {
    email: {
      type: 'positional',
      description: 'Collaborator email',
      required: true,
    },
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const email = String(args.email)
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app as string | undefined)
    if (isTestAccountEmail(email)) {
      throw new Refusal(
        'Test accounts (@deepspace.test) cannot be added as collaborators. Use a real DeepSpace account.',
        'test_account_cannot_be_collaborator',
      )
    }
    // Failure slugs (insufficient_credits, test_account_cannot_be_collaborator,
    // ...) are translated centrally by wrapCommandErrors — just let them escape.
    // An email with no DeepSpace user is no longer an error: the server creates
    // a pending invite ({status:'invited'}) and emails the person.
    const res = await api<AddResponse>(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}`,
      { method: 'POST', body: JSON.stringify({ email }) },
    )
    if (res.status === 'invited' || res.status === 'already_invited') {
      const expires = new Date(res.expiresAt).toLocaleDateString()
      if (res.status === 'already_invited') {
        if (!args.json) {
          console.log(
            `• ${res.email} already has a pending invite (expires ${expires}). ` +
              `No new email was sent. Cancel it with \`deepspace app collaborators cancel ${res.email}\` to reset.`,
          )
        }
        return { data: { ...res } }
      }
      if (!args.json) {
        console.log(
          `✓ Invite sent to ${res.email} (expires ${expires}). ` +
            `They become a collaborator when they sign in.`,
        )
      }
      return { data: { ...res } }
    }
    if (!args.json) console.log(`✓ ${res.collaborator.emailDisplay} can now deploy ${app}`)
    return { data: { ...res } }
  },
})

const remove = defineDeepspaceCommand({
  meta: { name: 'remove', description: 'Remove a collaborator from your app' },
  args: {
    email: { type: 'positional', description: 'Collaborator email', required: true },
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const email = String(args.email)
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app as string | undefined)
    const { collaborators } = await api<{ collaborators: Collaborator[] }>(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}`,
    )
    const target = email.trim().toLowerCase()
    const found = collaborators.find((c) => c.emailDisplay.toLowerCase() === target)
    if (!found) {
      throw new Refusal(`${email} is not a collaborator on ${app}`, 'not_a_collaborator', {
        action: cliAction('deepspace', 'app', 'collaborators', 'list', '--app', app),
      })
    }
    await api(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}/${encodeURIComponent(found.userId)}`,
      { method: 'DELETE' },
    )
    if (!args.json) console.log(`✓ ${found.emailDisplay} can no longer deploy ${app}`)
    // Terminal: nothing follows a removal.
    return { data: { removed: found } }
  },
})

const cancel = defineDeepspaceCommand({
  meta: { name: 'cancel', description: 'Cancel a pending (un-accepted) email invite' },
  args: {
    email: { type: 'positional', description: 'Invited email', required: true },
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const email = String(args.email)
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app as string | undefined)
    // Match against the pending list (mirrors `remove`) so we can tell the user
    // when there's nothing to cancel rather than silently no-op'ing the DELETE.
    const { pending = [] } = await api<{ pending?: PendingInvite[] }>(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}`,
    )
    const target = email.trim().toLowerCase()
    const found = pending.find((p) => p.email.toLowerCase() === target)
    if (!found) {
      throw new Refusal(`${email} has no pending invite on ${app}`, 'no_pending_invite', {
        action: cliAction('deepspace', 'app', 'collaborators', 'list', '--app', app),
      })
    }
    await api(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}/pending/${encodeURIComponent(found.email)}`,
      { method: 'DELETE' },
    )
    if (!args.json) console.log(`✓ Cancelled the pending invite to ${found.email} on ${app}`)
    // Terminal: nothing follows a cancellation.
    return { data: { cancelled: found } }
  },
})

// No `run()` on the parent: citty otherwise cascades it after each subcommand,
// printing spurious help text.
export default defineCommand({
  meta: { name: 'collaborators', description: 'Manage who can deploy your app' },
  subCommands: { list, add, remove, cancel },
})
