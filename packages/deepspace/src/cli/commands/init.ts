/**
 * `deepspace app init` — ensure this app carries its immutable identity.
 *
 * The id is SERVER-MINTED: init authenticates, asks the deploy worker's
 * `POST /api/apps/mint` for a fresh id registered to the caller, and writes
 * it into wrangler.toml (per wrangler env with --env) — init IS the
 * registration. `--new-id` replaces an existing id, which FORKS the repo
 * into a separate app: fresh
 * registration, fresh Durable Object data, fresh secrets store — the
 * original app is untouched.
 *
 * Defined with the command runtime (lib/command.ts): `--json`, the envelope,
 * the slug, the `Next:` line and the exit codes come from there.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { ApiError, apiFetch } from '../lib/api'
import { findAppDir } from '../lib/app-context'
import { getAppSource } from '../lib/source-api'
import { readAppId, writeAppId } from '../lib/app-identity'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { runGit } from '../lib/git/process'
import { ensureGitIdentity } from '../lib/vc-remote'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

/**
 * Complete a scaffold the login gate paused. The scaffolder git-inits the
 * repo but makes the initial commit only once the app has its identity, so a
 * logged-out scaffold arrives here with an UNBORN HEAD holding nothing but
 * scaffold output (an unborn `git worktree add` fails, so agents need this
 * healed). Commits only in that exact state — a repo with any history is the
 * user's to commit.
 */
function commitScaffoldIfUnborn(appDir: string, token: string): boolean {
  try {
    if (!existsSync(join(appDir, '.git'))) return false
    if (runGit(appDir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).status === 0) {
      return false
    }
    ensureGitIdentity(appDir, token)
    if (runGit(appDir, ['add', '-A'], { allowFail: true }).status !== 0) return false
    const commit = runGit(appDir, ['commit', '-m', 'Initial DeepSpace scaffold', '--no-verify'], {
      allowFail: true,
    })
    return commit.status === 0
  } catch {
    // No git on PATH (or an unreadable repo): identity is registered either
    // way; the commit is a convenience, never a failure of init.
    return false
  }
}

export default defineDeepspaceCommand({
  meta: {
    name: 'init',
    description: 'Register this app: mint its immutable DEEPSPACE_APP_ID into wrangler.toml',
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
      // "Already initialized" must mean REGISTERED, not merely id-shaped: an
      // older SDK's scaffold minted a valid-looking id locally that no server
      // ever registered, and early-returning on it made every recovery path a
      // dead loop (deploy/push/secrets refuse app_not_registered, init said
      // "already initialized"). Verify with the server before claiming done.
      const token = await ensureToken()
      let state
      try {
        state = await getAppSource(DEPLOY_URL, token, existing)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'forbidden') {
          // The id exists but belongs to someone else (e.g. a cloned repo).
          throw new Refusal(
            `wrangler.toml carries ${existing}, which is registered to another user. ` +
              'Run `deepspace app init --new-id` to fork this repo as your own app ' +
              '(new data and secrets; the original is untouched).',
            'not_app_owner',
          )
        }
        throw error
      }
      if (!state.registered) {
        throw new Refusal(
          `wrangler.toml carries ${existing}, but that id was never registered — it was ` +
            `minted locally by an older SDK. Ids are server-minted at registration now, and an ` +
            `existing unregistered id cannot be claimed. Run \`deepspace app init --new-id\` to ` +
            `register this repo as a fresh app (new data and secrets; nothing to migrate — the ` +
            `old id never had server-side state).`,
          'app_not_registered',
        )
      }
      if (!args.json) {
        console.log(`Already initialized: ${existing}${envName ? ` (env: ${envName})` : ''}`)
        console.log(`App dir: ${appDir}`)
      }
      return {
        data: { status: 'already_initialized', appId: existing, appDir, env: envName ?? null },
      }
    }
    const token = await ensureToken()
    const { appId } = await apiFetch<{ appId: string }>(DEPLOY_URL, token, '/api/apps/mint', {
      method: 'POST',
    })
    writeAppId(appDir, appId, { wranglerEnv: envName, force: Boolean(args['new-id']) })
    // wrangler.toml is the ONLY place the id lives: the client bundle resolves
    // it at build time from the same config (deepspace/build appIdDefine), so
    // there is nothing to stamp into source files — including on --new-id
    // forks, which previously needed re-stamping to avoid scoping the fork's
    // client to the original app.
    const committedScaffold = commitScaffoldIfUnborn(appDir, token)
    if (!args.json) {
      if (existing) {
        console.log(`Forked: ${existing} → ${appId}${envName ? ` (env: ${envName})` : ''}`)
        console.log('Registered as a NEW app under your account; the original is untouched.')
      } else {
        console.log(
          `Registered ${appId}${envName ? ` (env: ${envName})` : ''} to your account` +
            (committedScaffold
              ? ' — initial scaffold commit created.'
              : ' — commit wrangler.toml.'),
        )
        console.log('The first deploy claims the `name` subdomain.')
      }
      console.log(`App dir: ${appDir}`)
    }
    return {
      data: {
        status: existing ? 'forked' : 'registered',
        appId,
        ...(existing ? { previousAppId: existing } : {}),
        committedScaffold,
        appDir,
        env: envName ?? null,
      },
    }
  },
})
