/** Build and deploy a DeepSpace app through the platform deploy worker. */

import * as p from '@clack/prompts'
import { defineCommand } from 'citty'
import { resolve } from 'node:path'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { decodeJwtPayload } from '../../shared/jwt'
import { mintAppId, readAppId, writeAppId } from '../lib/app-identity'
import { ensureInstallReady } from '../lib/install-status'
import type { CliAction } from '../lib/output'
import { preflightNodeVersion } from '../lib/preflight'
import { createSpinner } from '../lib/spinner'
import { waitForLiveRelease, type ReleaseWait } from '../lib/edge-propagation'
import { MAX_DEPLOY_ASSET_FILE_BYTES, formatBytes } from '../../shared/app-files'
import {
  hasWranglerConfig,
  readWranglerConfig,
  resolveAppNameForEnv,
  type WranglerConfig,
} from '../lib/wrangler-env'
import { buildDeployBundle, oversizedAssetRefusal } from './deploy/build'
import { syncOneTimeProducts, syncSubscriptionPlans } from './deploy/commerce'
import { createDeployOutput, type DeployOutput } from './deploy/output'
import { deployBuiltBundle } from './deploy/request'
import { preflightDeployRepository, syncDeployRepository } from './deploy/repository'
import { getAppSource } from '../lib/source-api'
import { loadDeploySecrets, prepareDeploySecrets } from './deploy/secrets'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineCommand({
  meta: {
    name: 'deploy',
    // The per-file ceiling belongs in --help: it was previously discoverable
    // only by hitting it, after the build and the push had already run. The
    // per-deploy total is deliberately absent — it is env-configurable, so any
    // number stated here would be wrong for some environment.
    description: `Build and deploy your DeepSpace app (assets: ${formatBytes(MAX_DEPLOY_ASSET_FILE_BYTES)} per file)`,
  },
  args: {
    dir: {
      type: 'positional',
      description: 'App directory (default: current directory)',
      required: false,
    },
    env: {
      type: 'string',
      alias: 'e',
      description:
        'wrangler.toml [env.<name>] block to deploy (e.g. --env staging). ' +
        'Omit to deploy the top-level config.',
      required: false,
    },
    rename: {
      type: 'boolean',
      description:
        'Confirm that a changed wrangler `name` renames this app (its URL moves; data, secrets, and collaborators travel). Without this flag an interactive prompt asks.',
      default: false,
    },
    'claim-released': {
      type: 'boolean',
      description:
        'Platform admins only: claim an app name still inside its 30-day release cooldown. ' +
        'The previous owner permanently loses their reserved reclaim. ' +
        'Non-admin accounts are refused.',
      default: false,
    },
    // Citty maps --no-push to the negation of an argument named `push`.
    push: {
      type: 'boolean',
      description:
        'Sync DeepSpace source before deploying. GitHub source always deploys the local ' +
        'working tree without Git operations; --no-push opts DeepSpace source out of sync.',
      default: true,
    },
    'ignore-stale': {
      type: 'boolean',
      description:
        'Deploy even if someone released a newer version since you last synced (skips the ' +
        'stale-base guard).',
      default: false,
    },
    json: {
      type: 'boolean',
      description:
        'Emit a single-line JSON result for scripts/agents (human output goes to stderr)',
      default: false,
    },
  },
  async run({ args }) {
    const output = createDeployOutput(args.json === true)
    preflightNodeVersion('deploy')
    const appDir = resolve(args.dir ?? '.')

    const selectorRefusal = blankSelectorRefusal(args)
    if (selectorRefusal) output.die(selectorRefusal.error, selectorRefusal.code)
    const envName = typeof args.env === 'string' && args.env.trim() ? args.env.trim() : undefined

    if (!hasWranglerConfig(appDir)) {
      output.die('No wrangler.toml found. Are you in a DeepSpace app directory?', 'not_in_app_repo')
    }
    try {
      ensureInstallReady(appDir)
    } catch (error: unknown) {
      const refusal = error as { message?: string; code?: string; action?: CliAction }
      output.die(refusal.message ?? String(error), refusal.code ?? 'deps_missing', {
        action: refusal.action,
      })
    }

    p.intro('Deploying DeepSpace app')
    output.showIntro()

    const wranglerConfig: WranglerConfig = readWranglerConfig(appDir)
    const nameResult = resolveAppNameForEnv(wranglerConfig, envName)
    if (!nameResult.ok) return output.die(nameResult.reason, 'invalid_app_name')
    const declaredName = envName ? wranglerConfig.env?.[envName]?.name : wranglerConfig.name
    if (declaredName !== nameResult.name) {
      const location = envName ? `[env.${envName}].name` : '`name`'
      output.die(
        `wrangler.toml: ${location} "${declaredName}" is not in canonical form. ` +
          `Update it to "${nameResult.name}" and re-run.`,
        'invalid_app_name',
      )
    }
    const appName = nameResult.name
    let appId = readAppId(appDir, envName)
    p.log.info(envName ? `App: ${appName}  (env: ${envName})` : `App: ${appName}`)

    const { token, ownerId } = await authenticate(appDir, output)

    if (!appId) {
      appId = mintAppId()
      writeAppId(appDir, appId, { wranglerEnv: envName })
      p.log.info(`Minted app id ${appId} — commit wrangler.toml.`)
    }
    p.log.info(`Id: ${appId}`)

    const secretsCache = await loadDeploySecrets({
      deployUrl: DEPLOY_URL,
      appDir,
      appId,
      envName,
      ownerId,
      token,
      output,
    })
    const sourceState = await getAppSource(DEPLOY_URL, token, appId)

    const repositoryPreflight = preflightDeployRepository({
      appDir,
      push: args.push !== false,
      source: sourceState.source,
    })
    if (repositoryPreflight) {
      output.die(repositoryPreflight.error, repositoryPreflight.code)
    }

    // Build and size-check BEFORE the push. The push is the irreversible step
    // — it advances the cloud repo — and an asset the platform will refuse is
    // knowable from the local build, so refusing here leaves the repo exactly
    // where the caller left it instead of one commit ahead of a failed release.
    const spinner = createSpinner()
    const bundle = await buildDeployBundle({
      appDir,
      appName,
      envName,
      output,
      spinner,
    })
    const oversized = oversizedAssetRefusal(bundle.assets)
    if (oversized) {
      spinner.stop('Deploy failed')
      output.die(oversized, 'assets_too_large')
    }

    const repository = await syncDeployRepository({
      deployUrl: DEPLOY_URL,
      appDir,
      appId,
      token,
      push: args.push !== false,
      ignoreStale: Boolean(args['ignore-stale']),
      output,
      sourceState,
    })

    const secrets = prepareDeploySecrets({
      cache: secretsCache,
      customBindings: bundle.customBindings,
      doManifest: bundle.doManifest,
      output,
    })
    const body = await deployBuiltBundle({
      deployUrl: DEPLOY_URL,
      appDir,
      appId,
      appName,
      token,
      rename: args.rename === true,
      claimReleased: args['claim-released'] === true,
      ignoreStale: Boolean(args['ignore-stale']),
      bundle,
      secrets,
      repository,
      output,
      spinner,
    })

    let serving: ReleaseWait = 'unverifiable'
    const edgeWaitStarted = Date.now()
    if (body.url) {
      spinner.message('Waiting for the edge to serve this release...')
      serving = await waitForLiveRelease(body.url, body.releaseStamp, 90_000)
      if (serving !== 'confirmed') {
        spinner.stop(
          serving === 'unconfirmed'
            ? 'Deployed — the edge is still rolling this release out'
            : 'Deployed — serving could not be verified from here',
        )
        p.log.warn(
          serving === 'unconfirmed'
            ? 'Some requests still get the previous release. Cloudflare rolls a version out per ' +
                'edge machine; it usually settles within a couple of minutes. Wait before asserting against it.'
            : 'This release carries no serving stamp (older platform, or a resumed deploy), so the ' +
                'CLI cannot tell which release the edge answers with.',
        )
        p.log.info(`URL: ${body.url}`)
        await syncCommerce(appDir, appId, token, output.nonInteractive)
        if (output.json) {
          return output.emitJson({
            ok: true,
            appId,
            appName,
            url: body.url,
            releaseId: body.releaseId ?? null,
            bundleRetained: body.bundleRetained ?? null,
            serving,
            recoverable: repository.recoverable,
            ...staleBaseGuardFields(body),
          })
        }
        p.outro('Done')
        return
      }
    }

    spinner.stop(
      `Deployed! (edge confirmed in ${Math.round((Date.now() - edgeWaitStarted) / 1000)}s)`,
    )
    // Verified from HERE: ten independent connections agreed. Other regions
    // may still be rolling over — see lib/edge-propagation.ts.
    p.log.success(`Live at: ${body.url}`)
    await syncCommerce(appDir, appId, token, output.nonInteractive)
    if (output.json) {
      return output.emitJson({
        ok: true,
        appId,
        appName,
        url: body.url ?? null,
        // Always present, so a caller branches on one field instead of
        // inferring success from an absent one.
        serving,
        releaseId: body.releaseId ?? null,
        bundleRetained: body.bundleRetained ?? null,
        recoverable: repository.recoverable,
        ...staleBaseGuardFields(body),
      })
    }
    p.outro('Done')
  },
})

async function syncCommerce(
  appDir: string,
  appId: string,
  token: string,
  nonInteractive: boolean,
): Promise<void> {
  await syncSubscriptionPlans(appDir, appId, token, nonInteractive)
  await syncOneTimeProducts(appDir, appId, token)
}

/** Refuse explicit blank selectors before auth so they cannot fall back to production/cwd. */
export function blankSelectorRefusal(args: {
  dir?: unknown
  env?: unknown
}): { code: string; error: string } | null {
  if (args.env !== undefined && !String(args.env).trim()) {
    return {
      code: 'invalid_env',
      error:
        '--env was given an empty environment name — pass an env (e.g. --env staging), or omit --env to deploy the top-level config.',
    }
  }
  if (args.dir !== undefined && !String(args.dir).trim()) {
    return {
      code: 'invalid_dir',
      error:
        'The app directory argument was empty — pass a directory, or omit it to deploy the current directory.',
    }
  }
  return null
}

export function staleBaseGuardFields(body: {
  staleBaseGuard?: unknown
}): { staleBaseGuard: 'skipped' } | Record<string, never> {
  return body.staleBaseGuard === 'skipped' ? { staleBaseGuard: 'skipped' } : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function authenticate(
  appDir: string,
  output: DeployOutput,
): Promise<{ token: string; ownerId: string }> {
  try {
    const token = await ensureToken()
    return { token, ownerId: decodeJwtPayload<{ sub: string }>(token).sub }
  } catch (error: unknown) {
    output.die(errorMessage(error), 'not_authenticated', {
      action: { cwd: appDir, argv: ['deepspace', 'auth', 'login'] },
    })
  }
}
