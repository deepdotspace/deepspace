/**
 * Transfer app ownership — the GitHub-style offer/accept handshake.
 *
 * `deepspace transfer offer <email>` creates (or replaces) a 7-day offer;
 * the recipient runs `deepspace transfer accept --app <appId>` to commit.
 * Acceptance flips the registry owner and re-tags the deployed script for
 * billing in the same call. Either party can `cancel`. Data, secrets, and
 * routes travel with the app — only the owner (and billing) changes.
 */

import { defineCommand } from 'citty'
import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { requireAppIdArg, resolveAppTarget } from '../lib/app-context'
import { apiFetch as api } from '../lib/api'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api
const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

const offer = defineCommand({
  meta: { name: 'offer', description: 'Offer this app to another DeepSpace user' },
  args: {
    email: { type: 'positional', description: 'Recipient email', required: true },
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
    replace: {
      type: 'boolean',
      description: 'Replace a pending offer to someone else without asking',
    },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app)

    // The server replaces a pending offer wholesale — a stray second `offer`
    // used to silently revoke the first with no signal to anyone, and the
    // original recipient's `accept` then failed with a mystery 404. Surface
    // the pending offer and make replacing it a deliberate choice.
    const pending = await api<{ transfer: { toEmailDisplay: string } | null }>(
      API_URL,
      token,
      `/api/app-transfers/${encodeURIComponent(app)}`,
    )
    const pendingTo = pending.transfer?.toEmailDisplay
    if (
      pendingTo &&
      pendingTo.toLowerCase() !== args.email.trim().toLowerCase() &&
      !args.replace
    ) {
      if (!process.stdin.isTTY) {
        console.error(
          `A pending offer to ${pendingTo} already exists for ${app}. ` +
            'Re-run with --replace to replace it, or `deepspace transfer cancel` first.',
        )
        process.exit(1)
      }
      const yes = await p.confirm({
        message: `A pending offer to ${pendingTo} exists — replace it with ${args.email}?`,
      })
      if (p.isCancel(yes) || !yes) {
        console.log(`Kept the pending offer to ${pendingTo}.`)
        process.exit(1)
      }
    }

    const { expiresAt } = await api<{ toUserId: string; expiresAt: string }>(
      API_URL,
      token,
      `/api/app-transfers/${encodeURIComponent(app)}`,
      { method: 'POST', body: JSON.stringify({ email: args.email }) },
    )
    if (pendingTo && pendingTo.toLowerCase() !== args.email.trim().toLowerCase()) {
      console.log(`▲ Replaced the pending offer to ${pendingTo}.`)
    }
    console.log(
      `✓ Offered ${app} to ${args.email} (expires ${expiresAt}).\n` +
        `  They accept with: deepspace transfer accept --app ${app}`,
    )
  },
})

const status = defineCommand({
  meta: { name: 'status', description: 'Show the pending transfer offer, if any' },
  args: {
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app)
    const { transfer } = await api<{
      transfer: { toEmailDisplay: string; expiresAt: string } | null
    }>(API_URL, token, `/api/app-transfers/${encodeURIComponent(app)}`)
    if (!transfer) {
      console.log(`No pending transfer for ${app}.`)
      return
    }
    console.log(`Pending: ${app} → ${transfer.toEmailDisplay} (expires ${transfer.expiresAt}).`)
  },
})

const accept = defineCommand({
  meta: { name: 'accept', description: 'Accept a transfer offered to you' },
  args: {
    app: { type: 'string', alias: 'a', description: 'App id of the offered app', required: true },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = requireAppIdArg(args.app)
    await api(DEPLOY_URL, token, `/api/apps/${encodeURIComponent(app)}/transfer/accept`, {
      method: 'POST',
    })
    console.log(
      `✓ You now own ${app}. Run \`deepspace init\` in a fresh clone (or set ` +
        `DEEPSPACE_APP_ID = "${app}" in wrangler.toml) and deploy.`,
    )
  },
})

const cancel = defineCommand({
  meta: { name: 'cancel', description: 'Cancel/decline the pending offer (either party)' },
  args: {
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app)
    await api(API_URL, token, `/api/app-transfers/${encodeURIComponent(app)}`, { method: 'DELETE' })
    console.log(`✓ Transfer offer for ${app} cancelled.`)
  },
})

// No `run()` on the parent: citty otherwise cascades it after each subcommand.
export default defineCommand({
  meta: { name: 'transfer', description: 'Transfer app ownership to another user' },
  subCommands: { offer, status, accept, cancel },
})
