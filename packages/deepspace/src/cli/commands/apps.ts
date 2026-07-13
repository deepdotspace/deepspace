/**
 * deepspace apps
 *
 * Lists every app registered to the logged-in user — deployed or not — with
 * its id, live URL, and deploy state. This is the answer to "which app do I
 * undeploy?" when the deploy quota message names an id you've lost track of,
 * and the discovery surface for a second checkout / lost app dir.
 *
 * `--json` emits the raw entries for scripts.
 */

import { defineCommand } from 'citty'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { apiFetch } from '../lib/api'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

interface AppEntry {
  appId: string
  status: string
  createdAt: string
  deployedAt: string | null
  /** Current subdomain lease; null when undeployed. */
  name: string | null
  url: string | null
}

export default defineCommand({
  meta: {
    name: 'apps',
    description: 'List your apps (deployed and registered)',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit JSON instead of human output',
      default: false,
    },
  },
  async run({ args }) {
    const token = await ensureToken()
    const { apps } = await apiFetch<{ apps: AppEntry[] }>(DEPLOY_URL, token, '/api/apps')

    if (args.json) {
      process.stdout.write(JSON.stringify(apps, null, 2) + '\n')
      return
    }
    if (!apps.length) {
      console.log('No apps yet. Create one with `npx create-deepspace <name>` and `deepspace deploy`.')
      return
    }

    const nameWidth = Math.max(4, ...apps.map((a) => (a.name ?? '—').length))
    const idWidth = Math.max(6, ...apps.map((a) => a.appId.length))
    console.log(`${'NAME'.padEnd(nameWidth)}  ${'APP ID'.padEnd(idWidth)}  URL`)
    for (const a of apps) {
      const url = a.url ?? '(not deployed)'
      console.log(`${(a.name ?? '—').padEnd(nameWidth)}  ${a.appId.padEnd(idWidth)}  ${url}`)
    }
  },
})
