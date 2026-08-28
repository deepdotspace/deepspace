/**
 * Deploy-time secrets come from the app's secret store, and only from there —
 * and since 0.24 the deploy request carries no secret VALUES at all: the form
 * names the config (`secretsConfig`) and the platform reads its own store at
 * commit. This step's remaining jobs are dev parity and fail-fast:
 *
 *  - `.dev.vars` is a generated local cache: deploy WRITES it so `deepspace
 *    dev` has the same values, and never reads it back to decide anything.
 *  - The config-missing refusal fires here, BEFORE build/push/upload, with an
 *    executable fix. The server enforces the same refusal authoritatively at
 *    commit (it can also see the store), so this early copy is purely about
 *    failing before the expensive steps — request.ts maps the server's 409 to
 *    the same action for the race where the config vanishes in between.
 */

import * as p from '@clack/prompts'
import { ApiError } from '../../lib/api'
import { Refusal } from '../../lib/cli-errors'
import { writeDevVars } from '../../lib/dev-vars'
import { defaultConfigNameForEnv, refreshSecretsCache } from '../../lib/secrets'
import type { DeployOutput } from './output'

/**
 * The ONE env-scoped remedy for `secrets_config_missing` — shared by the
 * pre-deploy check below and the commit 409 backstop (request.ts), so the
 * two argvs cannot drift. The env flag is load-bearing: --env targets a
 * SEPARATE app, so a plain `configs create` would create the config on the
 * wrong one.
 */
export function secretsConfigCreateAction(
  appDir: string,
  configName: string,
  envName: string | undefined,
): { cwd: string; argv: string[] } {
  return {
    cwd: appDir,
    argv: [
      'deepspace',
      'secrets',
      'configs',
      'create',
      configName,
      ...(envName ? ['--env', envName] : []),
    ],
  }
}

export async function loadDeploySecrets(options: {
  deployUrl: string
  appDir: string
  appId: string
  envName: string | undefined
  ownerId: string
  token: string
  output: DeployOutput
}): Promise<{ configName: string }> {
  const { deployUrl, appDir, appId, envName, ownerId, token, output } = options
  const configName = defaultConfigNameForEnv(envName)
  let exists = false

  let refreshed
  try {
    // Pass configName explicitly: the probe and the deploy form must name
    // the same config by construction, not by parallel derivation.
    refreshed = await refreshSecretsCache(deployUrl, token, appId, envName, configName)
    exists = refreshed.pulled !== null
    if (refreshed.summary) p.log.info(refreshed.summary)
    // Name what ships: the platform reads the store at commit, so this
    // pre-deploy listing is the deploy flow's only preview of the key set —
    // authoritative up to a store write racing the build/upload window
    // (documented at commit.ts). The empty set is the one that can REMOVE
    // live secrets, so it warns — with wording that stays true for the
    // common never-written store (a 200-empty read cannot distinguish that
    // from an emptied config).
    const names = Object.keys(refreshed.pulled?.values ?? {}).sort()
    if (names.length) p.log.info(`App secrets: ${names.join(', ')}`)
    else if (exists) {
      // NOT on the 404 path: that one refuses below without deploying, so
      // this sentence would be false there. A never-written store reads
      // 200-empty and still lands here.
      p.log.warn(
        'App secrets: none — this deploy ships no user secrets and removes any live on the app',
      )
    }
  } catch (error: unknown) {
    if ((error as { status?: number })?.status === 403) {
      output.die(
        "You're not authorized to deploy this app — you must be its owner or a current " +
          'collaborator. If you were a collaborator, your access may have been revoked.',
        'not_authorized',
      )
    }
    output.die(
      `Failed to refresh app secrets before deploy: ${errorMessage(error)}`,
      'secrets_refresh_failed',
    )
  }
  // OUTSIDE the refresh catch: a dev-vars/app-token failure is not a secrets
  // problem — relabelling it secrets_refresh_failed buried the real code (an
  // agent branching on it would go create a secrets config for an auth or
  // wrong-URL fault). Let the error's own classification through.
  try {
    await writeDevVars(appDir, ownerId, token, envName, {
      appId,
      generatedSecretsCache: refreshed!.rendered,
    })
  } catch (error: unknown) {
    // writeDevVars raises the env-aware `app init` remedy itself; keep the
    // deploy-specific prefix and hand its action through unchanged.
    if (error instanceof Refusal && error.code === 'app_not_found') {
      output.die(`Could not write .dev.vars before deploy: ${error.message}`, error.code, {
        actionRequired: true,
        action: error.action,
      })
    }
    const code = error instanceof ApiError && error.code ? error.code : 'dev_vars_failed'
    output.die(`Could not write .dev.vars before deploy: ${errorMessage(error)}`, code)
  }

  if (!exists) {
    output.die(
      `Secrets config "${configName}" does not exist. Create it explicitly before deploying; ` +
        'this distinguishes an intentional empty config from an uninitialized app and protects ' +
        'live Worker secrets from a deleted config.',
      'secrets_config_missing',
      {
        actionRequired: true,
        action: secretsConfigCreateAction(appDir, configName, envName),
      },
    )
  }

  return { configName }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
