/**
 * deepspace undeploy
 *
 * Removes a deployed app from *.app.space via the deploy worker.
 */

import { defineCommand } from 'citty'
import { readAppId } from '../lib/app-identity'
import * as p from '@clack/prompts'
import { createSpinner } from '../lib/spinner'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { resolveAppSelector } from '../lib/app-context'
import { hasWranglerConfig } from '../lib/wrangler-env'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineCommand({
  meta: {
    name: 'undeploy',
    description: 'Remove a deployed DeepSpace app',
  },
  args: {
    name: {
      type: 'positional',
      description: 'App id or subdomain name to undeploy (reads DEEPSPACE_APP_ID from wrangler.toml if omitted)',
      required: false,
    },
    env: {
      type: 'string',
      description:
        'wrangler.toml [env.<name>] block whose deployed app to remove ' +
        '(e.g. --env staging). Ignored if a positional name is given.',
      required: false,
    },
  },
  async run({ args }) {
    const envName = typeof args.env === 'string' && args.env.trim() ? args.env.trim() : undefined

    // Token first — resolving a subdomain name to its id needs the registry.
    let token: string
    try {
      token = await ensureToken()
    } catch (err: unknown) {
      p.cancel(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    // Target: an explicit positional — app id OR live subdomain name, resolved
    // via the registry (DEP-5) — else DEEPSPACE_APP_ID from wrangler.toml.
    let appId: string | undefined
    const positional =
      typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined
    if (positional) {
      try {
        appId = await resolveAppSelector(DEPLOY_URL, token, positional)
      } catch (err: unknown) {
        p.cancel(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    } else if (hasWranglerConfig(process.cwd())) {
      appId = readAppId(process.cwd(), envName) ?? undefined
    }
    if (!appId) {
      p.cancel('Provide an app id or subdomain name, or run from a DeepSpace app directory with a DEEPSPACE_APP_ID.')
      process.exit(1)
    }

    p.intro(`Undeploying ${appId}`)
    const s = createSpinner()
    s.start('Removing...')

    const res = await fetch(`${DEPLOY_URL}/api/deploy/${appId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean
      error?: string
      releasedHosts?: string[]
    }

    if (!res.ok || !body.success) {
      s.stop('Failed')
      p.cancel(body.error ?? `Undeploy error (${res.status})`)
      process.exit(1)
    }

    s.stop('Removed')
    const hosts = body.releasedHosts ?? []
    p.outro(
      hosts.length
        ? `${hosts.join(', ')} taken down. The app keeps its id — redeploy to bring it back.`
        : `App ${appId} taken down.`,
    )
  },
})
