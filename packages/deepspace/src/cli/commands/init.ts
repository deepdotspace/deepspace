/**
 * `deepspace init` — ensure this app carries its immutable identity.
 *
 * Mints DEEPSPACE_APP_ID into wrangler.toml (per wrangler env with --env).
 * Registration happens at the first deploy. `--new-id` replaces an existing
 * id, which FORKS the repo into a separate app: fresh registration, fresh
 * Durable Object data, fresh secrets store — the original app is untouched.
 */

import { defineCommand } from 'citty'
import { findAppDir } from '../lib/app-context'
import { mintAppId, readAppId, writeAppId } from '../lib/app-identity'

export default defineCommand({
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
      console.error(
        'No wrangler.toml here — `deepspace init` stamps an app id into an existing ' +
          'DeepSpace app. To create a new app, run `deepspace create <name>` (or ' +
          '`npm create deepspace@latest <name>`), then run this from inside it.',
      )
      process.exit(1)
    }
    const envName = args.env || undefined
    const existing = readAppId(appDir, envName)
    if (existing && !args['new-id']) {
      console.log(`Already initialized: ${existing}${envName ? ` (env: ${envName})` : ''}`)
      return
    }
    const appId = mintAppId()
    writeAppId(appDir, appId, { wranglerEnv: envName, force: args['new-id'] })
    if (existing) {
      console.log(`Forked: ${existing} → ${appId}${envName ? ` (env: ${envName})` : ''}`)
      console.log('The next deploy registers this as a NEW app; the original is untouched.')
    } else {
      console.log(`Minted ${appId}${envName ? ` (env: ${envName})` : ''} — commit wrangler.toml.`)
      console.log('The first deploy registers it and claims the `name` subdomain.')
    }
  },
})
