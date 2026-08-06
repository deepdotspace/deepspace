/**
 * deepspace app list
 *
 * Lists every app registered to the logged-in user — deployed or not — with
 * its id, live URL, and deploy state. This is the answer to "which app do I
 * undeploy?" when the deploy quota message names an id you've lost track of,
 * and the discovery surface for a second checkout / lost app dir.
 *
 * `--json` emits the entries for scripts, under `apps` in the standard
 * `{ ok, … }` envelope.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, and the exit codes come from there, not from this file.
 */

import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { defineDeepspaceCommand } from '../lib/command'
import { listApps, liveAppUrl } from '../lib/app-target'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineDeepspaceCommand({
  meta: {
    name: 'apps',
    description: 'List your apps (deployed and registered)',
  },
  async run({ args }) {
    const token = await ensureToken()
    const apps = await listApps(DEPLOY_URL, token)

    if (!args.json) {
      if (!apps.length) {
        console.log('No apps yet. Create one with `npx create-deepspace <name>` and `deepspace deploy`.')
      } else {
        // Active apps hold quota slots — list them first so "which app do I
        // undeploy?" is answerable without scanning released registrations.
        const rows = [...apps].sort(
          (left, right) =>
            Number(right.status !== 'undeployed') - Number(left.status !== 'undeployed'),
        )
        // A newer CLI against an older deploy worker gets rows with no `role`;
        // reading `.length` off that crashed the whole listing.
        const roleOf = (a: (typeof rows)[number]) => a.role ?? 'owner'
        const roleWidth = Math.max(4, ...rows.map((a) => roleOf(a).length))
        const nameWidth = Math.max(4, ...rows.map((a) => (a.name ?? '—').length))
        const statusWidth = Math.max(6, ...rows.map((a) => a.status.length))
        const idWidth = Math.max(6, ...rows.map((a) => a.appId.length))
        console.log(
          `${'NAME'.padEnd(nameWidth)}  ${'STATUS'.padEnd(statusWidth)}  ${'ROLE'.padEnd(roleWidth)}  ${'APP ID'.padEnd(idWidth)}  URL`,
        )
        for (const a of rows) {
          const url = liveAppUrl(a) ?? '(not deployed)'
          console.log(
            `${(a.name ?? '—').padEnd(nameWidth)}  ${a.status.padEnd(statusWidth)}  ${roleOf(a).padEnd(roleWidth)}  ${a.appId.padEnd(idWidth)}  ${url}`,
          )
        }
      }
    }
    // No `next`: a listing is terminal — which app you act on, and how, is the
    // caller's choice.
    return { data: { apps } }
  },
})
