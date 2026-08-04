/** Build and deploy a DeepSpace app through the platform deploy worker. */

import * as p from '@clack/prompts'
import { defineCommand } from 'citty'
import { resolve } from 'node:path'
import { ensureToken } from '../auth'
import { PLATFORM_URLS } from '../env'
import { decodeJwtPayload } from '../jwt'
import { mintAppId, readAppId, writeAppId } from '../lib/app-identity'
import { ensureInstallReady } from '../lib/install-status'
import type { CliAction } from '../lib/output'
import { preflightNodeVersion } from '../lib/preflight'
import { createSpinner } from '../lib/spinner'
import {
  hasWranglerConfig,
  readWranglerConfig,
  resolveAppNameForEnv,
  type WranglerConfig,
} from '../lib/wrangler-env'
import { buildDeployBundle } from './deploy/build'
import { syncOneTimeProducts, syncSubscriptionPlans } from './deploy/commerce'
import { createDeployOutput, type DeployOutput } from './deploy/output'
import { deployBuiltBundle } from './deploy/request'
import { syncDeployRepository } from './deploy/repository'
import { getAppSource } from '../lib/source-api'
import { loadDeploySecrets, prepareDeploySecrets } from './deploy/secrets'
import { legacyDeployRefusal } from './migrate/legacy-app-id'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineCommand({
  meta: {
    name: 'deploy',
    description: 'Build and deploy your DeepSpace app',
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
    'allow-missing-secrets': {
      type: 'boolean',
      description:
        'Deploy even though hand-edited .dev.vars secrets are absent from the store (they will NOT be deployed, and any a previous deploy set are dropped).',
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
    if (!appId) {
      const refusal = legacyDeployRefusal(appDir, envName)
      if (refusal) output.die(refusal.error, refusal.code)
    }
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

    const spinner = createSpinner()
    const bundle = await buildDeployBundle({
      appDir,
      appName,
      envName,
      sharedDevVarsCache: secretsCache.linked !== null,
      wranglerConfig,
      output,
      spinner,
    })
    const secrets = prepareDeploySecrets({
      appDir,
      envName,
      cache: secretsCache,
      allowMissing: Boolean(args['allow-missing-secrets']),
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
      ignoreStale: Boolean(args['ignore-stale']),
      bundle,
      secrets,
      repository,
      output,
      spinner,
    })

    if (body.url) {
      spinner.message('Waiting for edge propagation...')
      const ready = await waitForAssetsReady(body.url, 90_000)
      if (!ready) {
        spinner.stop('Deployed (edge propagation still in progress after 90s)')
        p.log.warn(
          'First requests may briefly hit the assets transitional page; retry in a minute.',
        )
        p.log.info(`URL: ${body.url} (deploy accepted; serving not yet verified from here)`)
        await syncCommerce(appDir, appId, token, output.nonInteractive)
        if (output.json) {
          return output.emitJson({
            ok: true,
            appId,
            appName,
            url: body.url,
            docsUrl: body.docsUrl ?? null,
            releaseId: body.releaseId ?? null,
            bundleRetained: body.bundleRetained ?? null,
            edgePropagating: true,
            recoverable: repository.recoverable,
            ...staleBaseGuardFields(body),
          })
        }
        p.outro('Done')
        return
      }
    }

    spinner.stop('Deployed!')
    p.log.success(`Live at: ${body.url}`)
    if (body.docsUrl) p.log.success(`Docs at: ${body.docsUrl}`)
    await syncCommerce(appDir, appId, token, output.nonInteractive)
    if (output.json) {
      return output.emitJson({
        ok: true,
        appId,
        appName,
        url: body.url ?? null,
        docsUrl: body.docsUrl ?? null,
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

/** Wait until the new deployment is consistently serving across edge isolates. */
async function waitForAssetsReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let streak = 0

  while (Date.now() < deadline) {
    attempt++
    try {
      const response = await fetch(url, { redirect: 'manual' })
      const body = await response.text()
      if (!body.includes('Assets have not yet deployed') && !body.includes('No app configured')) {
        streak++
        if (streak >= 3) return true
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        continue
      }
      streak = 0
    } catch {
      streak = 0
    }

    const waitMs = Math.min(8_000, 1_000 * 2 ** (attempt - 1))
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  return false
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
