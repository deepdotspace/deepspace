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

import { ensureToken } from '../auth'
import { DEEPSPACE_ENV, PLATFORM_URLS } from '../env'
import { ApiError } from '../lib/api'
import { findAppDir } from '../lib/app-context'
import { getAppSource } from '../lib/source-api'
import { readAppId } from '../lib/app-identity'
import {
  accountLabel,
  commitScaffoldIfUnborn,
  mintAppIdentity,
  wranglerConfigUncommitted,
} from '../lib/app-registration'
import { errorCode } from '../lib/cli-errors'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'
import { readAppIdVar, readWranglerConfig } from '../lib/wrangler-env'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

// The registration mechanics live in lib/app-registration — the same
// chokepoint `resolveAppTarget` heals through on first use. Re-exported here
// because init's tests exercise them under this module's name.
export { mintAppIdentity, wranglerConfigUncommitted }

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
    // A malformed DEEPSPACE_APP_ID refuses (`invalid_app_id`, from the shared
    // reader) exactly like it does everywhere else — init must not mint a fresh
    // id over a value that may be a corrupted real one. Only an explicit
    // `--new-id` replaces it, and then the result names what it replaced.
    let existing: string | null
    let replacedMalformed: string | null = null
    try {
      existing = readAppId(appDir, envName)
    } catch (err) {
      if (errorCode(err) !== 'invalid_app_id' || !args['new-id']) throw err
      existing = null
      replacedMalformed = String(readAppIdVar(readWranglerConfig(appDir), envName))
    }
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
          // Env-aware remedy: a bare --new-id under --env would fork the
          // TOP-LEVEL slot, not the env that refused.
          throw new Refusal(
            `wrangler.toml carries ${existing}, which is registered to another user. ` +
              `Run \`deepspace app init --new-id${envName ? ` --env ${envName}` : ''}\` to fork ` +
              'this repo as your own app (new data and secrets; the original is untouched).',
            'not_app_owner',
          )
        }
        throw error
      }
      if (!state.registered) {
        // Executable, unlike the fork offered to a not_app_owner: forking
        // there is a data decision, and here there is no data — the old id
        // never had server-side state, so --new-id is the one next command.
        throw new Refusal(
          `wrangler.toml carries ${existing}, but that id was never registered — it was ` +
            `minted locally by an older SDK. Ids are server-minted at registration now, and an ` +
            `existing unregistered id cannot be claimed. Run ` +
            `\`deepspace app init --new-id${envName ? ` --env ${envName}` : ''}\` to ` +
            `register this repo as a fresh app (new data and secrets; nothing to migrate — the ` +
            `old id never had server-side state).`,
          'app_not_registered',
          {
            action: cliAction(
              'deepspace',
              'app',
              'init',
              '--new-id',
              ...(envName ? ['--env', envName] : []),
            ),
          },
        )
      }
      // A registered id with an UNBORN HEAD happens when another verb minted
      // first (the resolver never authors commits) — heal the scaffold commit
      // here too, or "already initialized" leaves the one state init exists
      // to finish.
      const healedScaffold = commitScaffoldIfUnborn(appDir, token)
      if (!args.json) {
        console.log(
          `Already initialized: ${existing}${envName ? ` (env: ${envName})` : ''} — registered on ${DEEPSPACE_ENV}` +
            (healedScaffold ? ' — initial scaffold commit created.' : ''),
        )
        console.log(`App dir: ${appDir}`)
      }
      return {
        data: {
          status: 'already_initialized',
          ...(healedScaffold ? { committedScaffold: true } : {}),
          appId: existing,
          appDir,
          env: DEEPSPACE_ENV,
          wranglerEnv: envName ?? null,
        },
      }
    }
    const token = await ensureToken()
    // wrangler.toml is the ONLY place the id lives: the client bundle resolves
    // it at build time from the same config (deepspace/build appIdDefine), so
    // there is nothing to stamp into source files — including on --new-id
    // forks, which previously needed re-stamping to avoid scoping the fork's
    // client to the original app.
    const { appId, committedScaffold } = await mintAppIdentity(appDir, token, {
      wranglerEnv: envName,
      force: Boolean(args['new-id']),
      commitScaffold: true,
    })
    if (!args.json) {
      const envSuffix = envName ? ` (env: ${envName})` : ''
      // The id lives only in wrangler.toml, so the follow-up is identical for a
      // first registration and for a `--new-id` fork — one suffix for both, so
      // the fork path cannot drift back into leaving the edit uncommitted.
      const commitNote = committedScaffold
        ? ' — initial scaffold commit created.'
        : ' — commit wrangler.toml.'
      if (existing) {
        console.log(`Forked: ${existing} → ${appId}${envSuffix}${commitNote}`)
        console.log(
          `Registered on ${DEEPSPACE_ENV} as a NEW app under ${accountLabel(token)}; the original is untouched.`,
        )
      } else {
        console.log(`Registered ${appId}${envSuffix} on ${DEEPSPACE_ENV} to ${accountLabel(token)}${commitNote}`)
        if (replacedMalformed !== null) {
          console.log(
            `Replaced the malformed DEEPSPACE_APP_ID ${JSON.stringify(replacedMalformed)} — it was never a registered id.`,
          )
        }
        console.log('The first deploy claims the `name` subdomain.')
      }
      console.log(`App dir: ${appDir}`)
    }
    return {
      data: {
        status: existing ? 'forked' : 'registered',
        appId,
        ...(existing ? { previousAppId: existing } : {}),
        ...(replacedMalformed !== null ? { replacedMalformed } : {}),
        committedScaffold,
        appDir,
        // The plane this registration lives on — `env` is what `status --json`
        // calls it too; the wrangler [env.<name>] slot is `wranglerEnv` there
        // and here.
        env: DEEPSPACE_ENV,
        wranglerEnv: envName ?? null,
      },
      // The one follow-up when the id was written into an existing history:
      // rendered as the `Next:` line and carried in `--json`, so a machine
      // caller does not have to infer it from `committedScaffold: false`.
      // Offered only when the file is actually uncommitted — `git commit` on
      // a clean file fails, and an action must be executable as handed over.
      ...(!committedScaffold && wranglerConfigUncommitted(appDir)
        ? {
            action: {
              cwd: appDir,
              argv: [
                'git',
                'commit',
                '-m',
                existing ? `Fork as ${appId}` : `Register ${appId}`,
                '--',
                'wrangler.toml',
              ],
            },
          }
        : {}),
    }
  },
})
