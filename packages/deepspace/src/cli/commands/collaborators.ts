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
    const { collaborators } = await api<{ collaborators: Collaborator[] }>(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}`,
    )
    if (args.json) {
      process.stdout.write(JSON.stringify(collaborators, null, 2) + '\n')
      return
    }
    if (!collaborators.length) {
      console.log(`No collaborators on ${app}. Add one with \`deepspace collaborators add <email>\`.`)
      return
    }
    // COL-4: print a header and the resolved email (emailDisplay). The raw
    // userId is dropped from the human view — it's still in --json, a human
    // reads the email, and `collaborators remove <email>` matches on it.
    console.log(`COLLABORATORS ON ${app}`)
    for (const c of collaborators) {
      console.log(`  ${c.emailDisplay}`)
    }
  },
})

const add = defineCommand({
  meta: { name: 'add', description: 'Authorize a DeepSpace user to deploy your app' },
  args: {
    email: {
      type: 'positional',
      description: 'Collaborator email (must already be a DeepSpace user)',
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
    // Failure slugs (user_not_found, test_account_cannot_be_collaborator, ...)
    // are translated centrally by wrapCommandErrors — just let them escape.
    const { collaborator } = await api<{ collaborator: Collaborator }>(
      token,
      `/api/app-collaborators/${encodeURIComponent(app)}`,
      { method: 'POST', body: JSON.stringify({ email: args.email }) },
    )
    if (args.json) {
      process.stdout.write(JSON.stringify(collaborator, null, 2) + '\n')
      return
    }
    console.log(`✓ ${collaborator.emailDisplay} can now deploy ${app}`)
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

// No `run()` on the parent: citty otherwise cascades it after each subcommand,
// printing spurious help text.
export default defineCommand({
  meta: { name: 'collaborators', description: 'Manage who can deploy your app' },
  subCommands: { list, add, remove },
})
