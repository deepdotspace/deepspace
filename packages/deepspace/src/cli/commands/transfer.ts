/**
 * Transfer app ownership — the GitHub-style offer/accept handshake.
 *
 * `deepspace app transfer offer <email>` creates (or replaces) a 7-day offer;
 * the recipient runs `deepspace app transfer accept --app <appId>` to commit.
 * Acceptance flips the registry owner and re-tags the deployed script for
 * billing in the same call. Either party can `cancel`. Data, secrets, and
 * routes travel with the app — only the owner (and billing) changes.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, the `Next:` line and the exit codes come from there. The one
 * confirmation prompt (`offer` over a pending offer to someone else) is
 * TTY-only: under `--json` a prompt is a hang, so it refuses with
 * `confirmation_required` and points at `--replace`.
 */

import { defineCommand } from 'citty'
import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { requireAppIdArg, resolveAppTarget } from '../lib/app-target'
import { apiFetch as api } from '../lib/api'
import { InputError } from '../lib/cli-errors'
import { defineDeepspaceCommand, Refusal } from '../lib/command'

const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api
const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

const offer = defineDeepspaceCommand({
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
    const email = String(args.email)
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app as string | undefined)

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
    if (pendingTo && pendingTo.toLowerCase() !== email.trim().toLowerCase() && !args.replace) {
      // No TTY (agent, pipe) or `--json` — a prompt would hang. Refuse with the
      // flag that resolves it instead.
      if (!process.stdin.isTTY || args.json) {
        throw new Refusal(
          `A pending offer to ${pendingTo} already exists for ${app}. ` +
            'Re-run with --replace to replace it, or `deepspace app transfer cancel` first.',
          'confirmation_required',
        )
      }
      const yes = await p.confirm({
        message: `A pending offer to ${pendingTo} exists — replace it with ${email}?`,
      })
      if (p.isCancel(yes) || !yes) {
        throw new Refusal(`Kept the pending offer to ${pendingTo}.`, 'cancelled')
      }
    }

    const { expiresAt } = await api<{ toUserId: string; expiresAt: string }>(
      API_URL,
      token,
      `/api/app-transfers/${encodeURIComponent(app)}`,
      { method: 'POST', body: JSON.stringify({ email }) },
    )
    const replaced = pendingTo && pendingTo.toLowerCase() !== email.trim().toLowerCase()
    if (!args.json) {
      if (replaced) console.log(`▲ Replaced the pending offer to ${pendingTo}.`)
      console.log(
        `✓ Offered ${app} to ${email} (expires ${expiresAt}).\n` +
          `  They accept with: deepspace app transfer accept --app ${app}`,
      )
    }
    return {
      data: {
        app,
        email,
        expiresAt,
        ...(replaced ? { replacedPendingTo: pendingTo } : {}),
      },
    }
  },
})

const status = defineDeepspaceCommand({
  meta: { name: 'status', description: 'Show the pending transfer offer, if any' },
  args: {
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app as string | undefined)
    const { transfer } = await api<{
      transfer: { toEmailDisplay: string; expiresAt: string } | null
    }>(API_URL, token, `/api/app-transfers/${encodeURIComponent(app)}`)
    if (!transfer) {
      if (!args.json) console.log(`No pending transfer for ${app}.`)
      return { data: { app, transfer: null } }
    }
    if (!args.json) {
      console.log(`Pending: ${app} → ${transfer.toEmailDisplay} (expires ${transfer.expiresAt}).`)
    }
    return { data: { app, transfer } }
  },
})

const accept = defineDeepspaceCommand({
  meta: { name: 'accept', description: 'Accept a transfer offered to you' },
  args: {
    app: { type: 'string', alias: 'a', description: 'App id of the offered app', required: true },
  },
  async run({ args }) {
    const token = await ensureToken()
    // requireAppIdArg throws an UNCODED Error for a malformed/absent id; the
    // envelope needs a slug, so give it one here (its InputErrors already have
    // theirs).
    let app: string
    try {
      app = requireAppIdArg(args.app as string | undefined)
    } catch (err: unknown) {
      if (err instanceof InputError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      throw new Refusal(msg, msg.startsWith('No app id') ? 'not_in_app_repo' : 'invalid_app')
    }
    await api(DEPLOY_URL, token, `/api/apps/${encodeURIComponent(app)}/transfer/accept`, {
      method: 'POST',
    })
    if (!args.json) {
      console.log(
        `✓ You now own ${app}. Run \`deepspace app init\` in a fresh clone (or set ` +
          `DEEPSPACE_APP_ID = "${app}" in wrangler.toml) and deploy.`,
      )
    }
    return { data: { app, accepted: true } }
  },
})

const cancel = defineDeepspaceCommand({
  meta: { name: 'cancel', description: 'Cancel/decline the pending offer (either party)' },
  args: {
    app: { type: 'string', alias: 'a', description: 'App id or name (defaults to ./wrangler.toml)' },
  },
  async run({ args }) {
    const token = await ensureToken()
    const app = await resolveAppTarget(DEPLOY_URL, token, args.app as string | undefined)
    await api(API_URL, token, `/api/app-transfers/${encodeURIComponent(app)}`, { method: 'DELETE' })
    if (!args.json) console.log(`✓ Transfer offer for ${app} cancelled.`)
    // Terminal: nothing follows a cancellation.
    return { data: { app, cancelled: true } }
  },
})

// No `run()` on the parent: citty otherwise cascades it after each subcommand.
export default defineCommand({
  meta: { name: 'transfer', description: 'Transfer app ownership to another user' },
  subCommands: { offer, status, accept, cancel },
})
