/**
 * deepspace app undeploy
 *
 * Removes a deployed app from *.app.space via the deploy worker.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug and the exit codes come from there. Undeploy is TERMINAL — it emits
 * no `Next:` line (the human outro already says a redeploy brings it back).
 */

import { readAppId } from '../lib/app-identity'
import * as p from '@clack/prompts'
import { createSpinner } from '../lib/spinner'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { resolveAppSelector } from '../lib/app-target'
import { hasWranglerConfig } from '../lib/wrangler-env'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineDeepspaceCommand({
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
      throw new Refusal(err instanceof Error ? err.message : String(err), 'not_authenticated', {
        action: cliAction('deepspace', 'auth', 'login'),
      })
    }

    // Target: an explicit positional — app id OR live subdomain name, resolved
    // via the registry (DEP-5) — else DEEPSPACE_APP_ID from wrangler.toml.
    // resolveAppSelector's own InputErrors already carry codes (app_not_found,
    // invalid_app, invalid_response); let them escape rather than re-wrap.
    let appId: string | undefined
    const positional =
      typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined
    if (positional) {
      appId = await resolveAppSelector(DEPLOY_URL, token, positional)
    } else if (hasWranglerConfig(process.cwd())) {
      appId = readAppId(process.cwd(), envName) ?? undefined
    }
    if (!appId) {
      throw new Refusal(
        'Provide an app id or subdomain name, or run from a DeepSpace app directory with a DEEPSPACE_APP_ID.',
        'not_in_app_repo',
      )
    }

    if (!args.json) p.intro(`Undeploying ${appId}`)
    const s = args.json ? null : createSpinner()
    s?.start('Removing...')

    const res = await fetch(`${DEPLOY_URL}/api/deploy/${appId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean
      error?: string
      code?: string
      releasedHosts?: string[]
    }

    if (!res.ok || !body.success) {
      s?.stop('Failed')
      if (body.code === 'registry_takedown_failed') {
        throw new Refusal(
          body.error ?? 'Registry takedown failed after the cloud script was removed.',
          body.code,
          {
            actionRequired: true,
            action: cliAction('deepspace', 'app', 'undeploy', appId),
            extra: { appId },
          },
        )
      }
      throw new Refusal(body.error ?? `Undeploy error (${res.status})`, 'undeploy_failed')
    }

    s?.stop('Removed')
    const hosts = body.releasedHosts ?? []
    if (!args.json) {
      p.outro(
        hosts.length
          ? `${hosts.join(', ')} taken down. The app keeps its id — redeploy to bring it back.`
          : `App ${appId} taken down.`,
      )
    }
    return { data: { appId, releasedHosts: hosts } }
  },
})
