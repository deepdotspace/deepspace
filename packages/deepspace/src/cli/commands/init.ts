/**
 * `deepspace app init` — ensure this app carries its immutable identity.
 *
 * Mints DEEPSPACE_APP_ID into wrangler.toml (per wrangler env with --env).
 * Registration happens at the first deploy. `--new-id` replaces an existing
 * id, which FORKS the repo into a separate app: fresh registration, fresh
 * Durable Object data, fresh secrets store — the original app is untouched.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, the `Next:` line and the exit codes come from there.
 */

import { findAppDir } from '../lib/app-context'
import { mintAppId, readAppId, writeAppId } from '../lib/app-identity'
import { defineDeepspaceCommand, Refusal } from '../lib/command'

export default defineDeepspaceCommand({
  meta: {
    name: 'init',
    description: 'Mint this app’s immutable DEEPSPACE_APP_ID into wrangler.toml',
  },
  args: {
    'new-id': {
      type: 'boolean',
      description:
        'Replace the existing id — forks this repo as a SEPARATE app (new data, new secrets, new registration). The original app keeps running.',
      default: false,
    },
    env: {
      type: 'string',
      alias: 'e',
      description: 'wrangler.toml [env.<name>] block to stamp (each env is its own app)',
      required: false,
    },
  },
  async run({ args }) {
    const appDir = findAppDir()
    if (!appDir) {
      throw new Refusal(
        'No wrangler.toml here — `deepspace app init` stamps an app id into an existing ' +
          'DeepSpace app. To create a new app, run `deepspace app create <name>` (or ' +
          '`npm create deepspace@latest <name>`), then run this from inside it.',
        'not_an_app',
      )
    }
    const envName = (args.env as string) || undefined
    const existing = readAppId(appDir, envName)
    if (existing && !args['new-id']) {
      if (!args.json) {
        console.log(`Already initialized: ${existing}${envName ? ` (env: ${envName})` : ''}`)
        console.log(`App dir: ${appDir}`)
      }
      return {
        data: { status: 'already_initialized', appId: existing, appDir, env: envName ?? null },
      }
    }
    const appId = mintAppId()
    writeAppId(appDir, appId, { wranglerEnv: envName, force: Boolean(args['new-id']) })
    if (!args.json) {
      if (existing) {
        console.log(`Forked: ${existing} → ${appId}${envName ? ` (env: ${envName})` : ''}`)
        console.log('The next deploy registers this as a NEW app; the original is untouched.')
      } else {
        console.log(`Minted ${appId}${envName ? ` (env: ${envName})` : ''} — commit wrangler.toml.`)
        console.log('The first deploy registers it and claims the `name` subdomain.')
      }
      console.log(`App dir: ${appDir}`)
    }
    return {
      data: {
        status: existing ? 'forked' : 'minted',
        appId,
        ...(existing ? { previousAppId: existing } : {}),
        appDir,
        env: envName ?? null,
      },
    }
  },
})
