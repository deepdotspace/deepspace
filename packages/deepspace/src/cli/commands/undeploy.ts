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
import { listApps, resolveAppSelector } from '../lib/app-target'
import { hasWranglerConfig, readWranglerConfig } from '../lib/wrangler-env'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'
import { requireConsent } from '../lib/consent'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineDeepspaceCommand({
  meta: {
    name: 'undeploy',
    description: 'Remove a deployed DeepSpace app',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'App id or subdomain name to undeploy (reads DEEPSPACE_APP_ID from wrangler.toml if omitted)',
      required: false,
    },
    env: {
      type: 'string',
      description:
        'wrangler.toml [env.<name>] block whose deployed app to remove ' +
        '(e.g. --env staging). Ignored if a positional name is given.',
      required: false,
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description: 'Skip the confirmation (required for --json / non-interactive)',
      default: false,
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
    // What the operator recognizes: the name they typed, else the wrangler
    // `name`, else the id.
    let label: string | undefined
    const positional =
      typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined
    if (positional) {
      appId = await resolveAppSelector(DEPLOY_URL, token, positional)
      label = positional
    } else if (hasWranglerConfig(process.cwd())) {
      appId = readAppId(process.cwd(), envName) ?? undefined
      const config = readWranglerConfig(process.cwd())
      label = (envName ? config.env?.[envName]?.name : undefined) ?? config.name
    }
    if (!appId) {
      throw new Refusal(
        'Provide an app id or subdomain name, or run from a DeepSpace app directory with a DEEPSPACE_APP_ID.',
        'not_in_app_repo',
      )
    }

    const target = label && label !== appId ? `${label} (${appId})` : appId

    // Ownership BEFORE consent: the consent refusal says "re-run with
    // --yes", and saying that to a collaborator invites a non-owner to
    // re-run the most destructive verb with the destructive flag attached —
    // only to hit the server's not_app_owner (v0.26.0 collab AX). One list
    // read settles it; an app not in the caller's list at all is left to the
    // server's authoritative check (admin and race cases).
    try {
      const mine = await listApps(DEPLOY_URL, token)
      const entry = mine.find((app) => app.appId === appId)
      if (entry?.role === 'collaborator') {
        throw new Refusal(
          `Only the app owner can undeploy ${target} — you are a collaborator. Ask the owner, or fork your own copy with \`deepspace app init --new-id\`.`,
          'not_app_owner',
          { extra: { appId } },
        )
      }
    } catch (error) {
      if (error instanceof Refusal) throw error
      // The listing is advisory; the server still enforces ownership.
    }

    // The most destructive app command, so consent is never implicit — the
    // shared gate (lib/consent.ts): --yes, or refuse under --json/non-TTY,
    // or a default-No prompt. The sentence must match what undeploy does
    // (docs: app-identity guide): the worker and its Durable Objects go, so
    // the app's data goes with them; secrets, app files, and the
    // registration stay.
    await requireConsent({
      yes: args.yes === true,
      json: args.json === true,
      message: `Undeploying ${target} takes its URL offline immediately and destroys its live data — records, messages, canvas state, cron history — with the worker (secrets, app files, and the registration stay).`,
      prompt: `Take ${target} offline now? Its URL stops serving immediately and its data — records, messages, canvas state, cron history — is destroyed with the worker. Secrets, app files, and the registration stay (the name is reserved for you for 30 days).`,
      declineMessage: 'Undeploy cancelled.',
      declineCode: 'undeploy_declined',
      extra: { appId },
    })
    if (!args.json) p.intro(`Undeploying ${target}`)
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
      throw new Refusal(
        body.error ?? `Undeploy error (${res.status})`,
        body.code ?? 'undeploy_failed',
      )
    }

    const hosts = body.releasedHosts ?? []
    // The registry released no route: nothing was serving — the app was
    // already undeployed (or never deployed). Say so, the way `auth logout`
    // reports `alreadyLoggedOut`, instead of claiming a takedown that did not
    // happen; the exit code alone could not tell success from no-op.
    const alreadyUndeployed = hosts.length === 0
    s?.stop(alreadyUndeployed ? 'Nothing to remove' : 'Removed')
    if (!args.json) {
      p.outro(
        alreadyUndeployed
          ? `${target} was already offline — no URL was serving, so nothing changed. The app keeps its id; redeploy to bring it back.`
          : `${hosts.join(', ')} taken down. The app keeps its id — redeploy to bring it back.`,
      )
    }
    return { data: { appId, releasedHosts: hosts, alreadyUndeployed } }
  },
})
