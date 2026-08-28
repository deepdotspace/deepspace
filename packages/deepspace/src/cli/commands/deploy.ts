/** Build and deploy a DeepSpace app through the platform deploy worker. */

import * as p from '@clack/prompts'
import { defineCommand } from 'citty'
import { join, resolve } from 'node:path'
import { ensureToken, refreshTokenFromSession } from '../auth'
import { PLATFORM_URLS } from '../env'
import { commitScaffoldIfUnborn, ensureAppRegistered, healRefusal } from '../lib/app-registration'
import { decodeJwtPayload } from '../../shared/jwt'
import { readAppId } from '../lib/app-identity'
import { ensureInstallReady } from '../lib/install-status'
import type { CliAction } from '../lib/output'
import { preflightNodeVersion } from '../lib/preflight'
import { createSpinner, setPlainProgress } from '../lib/spinner'
import { wakeWorker, waitForLiveRelease, type ReleaseWait } from '../lib/edge-propagation'
import { MAX_DEPLOY_ASSET_FILE_BYTES, formatBytes } from '../../shared/app-files'
import {
  hasWranglerConfig,
  noWranglerConfigMessage,
  readWranglerConfig,
  resolveAppNameForEnv,
  type WranglerConfig,
} from '../lib/wrangler-env'
import { buildDeployBundle, oversizedAssetRefusal } from './deploy/build'
import { syncOneTimeProducts, syncSubscriptionPlans } from './deploy/commerce'
import { createDeployOutput, type DeployOutput } from './deploy/output'
import { CliExit, Refusal, errorCode, formatCliError } from '../lib/cli-errors'
import {
  deployBuiltBundle,
  renamePromptMessage,
  renameRefusalMessage,
  requireDeployCapabilities,
  STALE_DISPLAY_NAME_LOCATIONS,
} from './deploy/request'
// Re-exported so the rename wording keeps one import site for tests and callers.
export { renamePromptMessage, renameRefusalMessage }
import { preflightDeployRepository, syncDeployRepository } from './deploy/repository'
import { getAppSource } from '../lib/source-api'
import { loadDeploySecrets } from './deploy/secrets'
import { acquireDeployLock } from './deploy/lock'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy
/** Leave enough bearer lifetime for source sync + asset upload before the
 * final commit's exact 401 recovery takes over. Fresh CLI JWTs last 15m. */
const DEPLOY_TOKEN_MIN_VALIDITY_MS = 10 * 60 * 1000
const POST_DEPLOY_TOKEN_MIN_VALIDITY_MS = 2 * 60 * 1000

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
    // Under --json every spinner becomes a static line through the redirected
    // stdout above — recorded for the crash envelope, printed on stderr.
    setPlainProgress(output.json)
    // Every failure leaves through `output.die`, deploy's one exit door. An
    // error that escaped this body used to reach the shared renderer, whose
    // JSON envelope landed on the stdout deploy has redirected — and the exit
    // fallback then wrapped that JSON *as the error string* under
    // `deploy_failed`, hiding the real code (`forbidden`, `app_not_found`, …).
    try {
      await runDeploy(args, output)
    } catch (error) {
      if (error instanceof CliExit) throw error
      // A Refusal keeps its action, tier, and machine fields (the lock's
      // holder, a stale-base's release) on the way out — the door must not
      // strip what the refusal was built to say.
      const refusal = error instanceof Refusal ? error : undefined
      output.die(formatCliError(error), errorCode(error) ?? 'deploy_failed', {
        action: refusal?.action,
        actionRequired: refusal?.actionRequired,
        extra: refusal?.extra,
      })
    }
  },
})

/** The parsed flags `runDeploy` reads (citty's own type is inferred inline). */
interface DeployArgs {
  dir?: string
  env?: string | boolean
  json?: boolean
  push?: boolean
  rename?: boolean
  'ignore-stale'?: boolean
  'claim-released'?: boolean
}

async function runDeploy(args: DeployArgs, output: DeployOutput): Promise<void> {
  preflightNodeVersion('deploy')
  const appDir = resolve(args.dir ?? '.')

  const selectorRefusal = blankSelectorRefusal(args)
  if (selectorRefusal) output.die(selectorRefusal.error, selectorRefusal.code)
  const envName = typeof args.env === 'string' && args.env.trim() ? args.env.trim() : undefined

  if (!hasWranglerConfig(appDir)) {
    output.die(noWranglerConfigMessage(join(appDir, 'wrangler.toml')), 'not_in_app_repo')
  }
  // One deploy per checkout: taken before any work, released on every exit.
  // The dependency heal runs INSIDE it (see runLockedDeploy) — two deploys
  // must not race two package managers into one node_modules.
  const releaseLock = acquireDeployLock(appDir)
  try {
    await runLockedDeploy(args, output, appDir, envName)
  } finally {
    releaseLock()
  }
}

async function runLockedDeploy(
  args: DeployArgs,
  output: DeployOutput,
  appDir: string,
  envName: string | undefined,
): Promise<void> {
  p.intro('Deploying DeepSpace app')
  output.showIntro()

  const wranglerConfig: WranglerConfig = readWranglerConfig(appDir)
  const nameResult = resolveAppNameForEnv(wranglerConfig, envName)
  if (!nameResult.ok) return output.die(nameResult.reason, nameResult.code ?? 'invalid_app_name')
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

  // After auth (a logged-out user must not sit through a full install only to
  // hit not_authenticated) and inside the deploy lock (no concurrent installs
  // into one node_modules).
  try {
    ensureInstallReady(appDir)
  } catch (error: unknown) {
    const refusal = error as { message?: string; code?: string; action?: CliAction }
    return output.die(refusal.message ?? String(error), refusal.code ?? 'install_failed', {
      action: refusal.action,
    })
  }

  if (!appId) {
    // First use REGISTERS: nothing has to be registered "at the beginning".
    // The id must exist before the build (the client bundle bakes it in via
    // deepspace/build appIdDefine), so it is healed here — after auth, before
    // any other work — through the same chokepoint every other verb resolves
    // through. `readAppId` has already refused a malformed value
    // (`invalid_app_id`), so this only ever fills a genuinely absent slot.
    const ensured = await ensureAppRegistered(appDir, token, envName, { commitScaffold: true })
    if (!ensured) {
      // healRefusal diagnoses WHICH state blocked minting — an undeclared
      // env block, a config that never mentions DEEPSPACE_APP_ID, or a
      // placeholder committed to history (the GitHub lane's first deploy,
      // where the true remedy is `app init`, not "wrong directory").
      const refusal = healRefusal(appDir, envName)
      return output.die(refusal.message, refusal.code, {
        action: refusal.action,
        actionRequired: refusal.action !== undefined,
      })
    }
    appId = ensured.appId
  }
  // ALWAYS, not only when this run minted: another verb (`secrets set`,
  // `dev start`) may have registered first — those never author commits, so
  // the scaffold can arrive here with a real id and a still-unborn HEAD.
  // Without this, the DeepSpace preflight then refused `dirty_worktree` on a
  // scaffold the user never touched, and `app init` (already initialized)
  // would not heal it either. No-op the moment HEAD exists.
  commitScaffoldIfUnborn(appDir, token)
  p.log.info(`Id: ${appId}`)

  // Registration first: it is the cheapest, most specific precondition, and
  // every later server call (the secrets refresh included) refuses an
  // unregistered id with a less useful sentence. Refuse HERE, before any
  // build or push: without this, the failure surfaces later as a raw git
  // 404 from the repo transport (git discards response bodies), which reads
  // as infra breakage instead of the registration gap it is.
  const sourceState = await getAppSource(DEPLOY_URL, token, appId).catch((error: unknown) => {
    // The server's `forbidden` is a bare "Not authorized". The one fact that
    // recovers this state is WHO is signed in and WHOSE app this is — both
    // known here, so say them once, on the first server call.
    if (errorCode(error) === 'forbidden') {
      output.die(forbiddenDeployMessage(appId, token), 'forbidden')
    }
    throw error
  })
  if (!sourceState.registered) {
    output.die(
      `${appId} is not registered. If this repo's id came from an older SDK's scaffold, run ` +
        `\`deepspace app init --new-id${envName ? ` --env ${envName}` : ''}\` to register it as ` +
        `a fresh app; a brand-new app dir registers with ` +
        `\`deepspace app init${envName ? ` --env ${envName}` : ''}\`.`,
      'app_not_registered',
    )
  }
  // The capability handshake runs BEFORE anything with a cost: the secrets
  // refresh, the build, and — the irreversible one — the repo push. Against
  // an old server this refuses with the repo untouched.
  await requireDeployCapabilities(DEPLOY_URL, null, output)

  const { configName: secretsConfig } = await loadDeploySecrets({
    deployUrl: DEPLOY_URL,
    appDir,
    appId,
    envName,
    ownerId,
    token,
    output,
  })

  // Both refusals the platform can only reach at commit time, settled here
  // from the response the CLI already fetched — before the build and the
  // ~hundreds of KiB of asset uploads that used to precede them. The server
  // keeps both checks; these only move the refusal to where it costs nothing.
  const ownerJwtRefusal = ownerJwtMissingRefusal(sourceState)
  if (ownerJwtRefusal) output.die(ownerJwtRefusal.error, ownerJwtRefusal.code)
  // The platform answers `onBehalf` only to a non-owner: say so here, since
  // nothing else in a deploy's output tells a collaborator they are shipping
  // an app that belongs to another account (v0.26.0 collab AX).
  if (sourceState.onBehalf) {
    process.stderr.write(
      'Deploying on behalf of the owner — this app belongs to another account.\n',
    )
  }

  let confirmRename = args.rename === true
  const rename = pendingRename(sourceState.registeredHost, appName)
  if (rename && !confirmRename) {
    if (output.nonInteractive) {
      output.die(renameRefusalMessage(rename), 'rename_required')
    }
    const confirmed = await p.confirm({ message: renamePromptMessage(rename) })
    if (p.isCancel(confirmed) || !confirmed) output.die('Deploy cancelled.', 'rename_declined')
    confirmRename = true
  }

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
    appId,
    envName,
    output,
    spinner,
  })
  const oversized = oversizedAssetRefusal(bundle.assets)
  if (oversized) {
    spinner.stop('Deploy failed')
    output.die(oversized, 'assets_too_large')
  }

  // Building is the longest unauthenticated phase. The token captured before
  // it may now be near expiry even though ensureToken accepted it at command
  // start, so re-check against the work still ahead before mutating source.
  const { token: deployToken } = await authenticate(appDir, output, DEPLOY_TOKEN_MIN_VALIDITY_MS)

  const repository = await syncDeployRepository({
    deployUrl: DEPLOY_URL,
    appDir,
    appId,
    token: deployToken,
    push: args.push !== false,
    ignoreStale: Boolean(args['ignore-stale']),
    output,
    sourceState,
  })

  const body = await deployBuiltBundle({
    deployUrl: DEPLOY_URL,
    appDir,
    appId,
    appName,
    token: deployToken,
    refreshToken: refreshTokenFromSession,
    rename: confirmRename,
    claimReleased: args['claim-released'] === true,
    ignoreStale: Boolean(args['ignore-stale']),
    bundle,
    secretsConfig,
    envName,
    repository,
    output,
    spinner,
  })

  // What tree this release shipped. Under DeepSpace source these restate a
  // guarded invariant (a dirty worktree is refused, and `commitOid` pins the
  // code); under GitHub source they are the ONLY record of it — that path ships
  // the working tree from any branch, uncommitted edits included, and records
  // no commit, so nothing else can say afterwards what went live.
  const worktree = {
    branch: repository.branch,
    dirty: repository.dirty,
    // What authority shipped, in the envelope the deployer already has — the
    // human stream announces it, and without this a script had to make a
    // second call (`releases --json`) to log it (v0.26.0 github AX).
    source: shippedSourceEvidence(repository),
  }

  // A rename that landed. Two mutually exclusive paths settle one: the
  // pre-build check above (whenever the platform reported `registeredHost`) or
  // the commit-time 409 inside deployBuiltBundle. Reported once, on BOTH
  // surfaces — the stale display name is the whole reason a renamed app keeps
  // serving its old name, and until now only the interactive prompt said so.
  const renamedFrom = rename?.fromHost ?? body.renamedFrom ?? null
  const renameFields = renamedFrom
    ? { renamedFrom, staleDisplayName: [...STALE_DISPLAY_NAME_LOCATIONS] }
    : {}
  if (renamedFrom) {
    p.log.warn(
      `Renamed from ${renamedFrom}. The display name did NOT travel — it is still the old ` +
        `name in ${STALE_DISPLAY_NAME_LOCATIONS.join(' and ')}; update both and redeploy.`,
    )
  }

  let serving: ReleaseWait = 'unverifiable'
  const edgeWaitStarted = Date.now()
  if (body.url) {
    spinner.message('Waiting for the edge to serve this release...')
    serving = await waitForLiveRelease(body.url, body.releaseStamp, 90_000)
    if (serving === 'confirmed') await wakeWorker(body.url)
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
      await syncPostDeployCommerce(appDir, appId, output.nonInteractive)
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
          ...worktree,
          ...renameFields,
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
  await syncPostDeployCommerce(appDir, appId, output.nonInteractive)
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
      ...worktree,
      ...renameFields,
      ...staleBaseGuardFields(body),
    })
  }
  p.outro('Done')
}

async function syncCommerce(
  appDir: string,
  appId: string,
  token: string,
  nonInteractive: boolean,
): Promise<void> {
  await syncSubscriptionPlans(appDir, appId, token, nonInteractive)
  await syncOneTimeProducts(appDir, appId, token)
}

/** Commerce metadata follows a successful release, so auth trouble here must
 * never relabel an already-live deploy as failed or invite a duplicate retry. */
async function syncPostDeployCommerce(
  appDir: string,
  appId: string,
  nonInteractive: boolean,
): Promise<void> {
  try {
    const token = await ensureToken({ minimumValidityMs: POST_DEPLOY_TOKEN_MIN_VALIDITY_MS })
    await syncCommerce(appDir, appId, token, nonInteractive)
  } catch (error) {
    p.log.warn(`Deployed successfully, but commerce sync was skipped: ${errorMessage(error)}`)
  }
}

/** The source evidence a deploy's `--json` envelope carries — the same shape
 *  `releases --json` uses; `inferred: true` marks unclaimed-GitHub evidence.
 *  Pure + exported for tests. */
export function shippedSourceEvidence(repository: {
  source: { provider: 'deepspace' } | { provider: 'github'; repository: string } | null
  observedRepository: string | null
}): { provider: 'github'; repository: string; inferred?: true } | { provider: 'deepspace' } | null {
  if (repository.source?.provider === 'github') {
    return { provider: 'github', repository: repository.source.repository }
  }
  if (repository.source?.provider === 'deepspace') return { provider: 'deepspace' }
  if (repository.observedRepository) {
    return { provider: 'github', repository: repository.observedRepository, inferred: true }
  }
  return null
}

/**
 * A collaborator's (or admin's) deploy of an app the owner has never deployed:
 * the platform cannot preserve secrets it has no live version to inherit them
 * from, so the deploy is refused — at commit time, after the whole bundle was
 * built and uploaded. The pre-build `/source` response answers the same
 * question, so refuse here instead.
 *
 * The sentence is the deploy worker's own (`cloudflare-deploy.ts`, pinned by
 * `tests/docker/collaborators.sh`); `owner_jwt_missing` is the machine code
 * both sides now send.
 */
export function ownerJwtMissingRefusal(state: {
  onBehalf?: { ownerJwtLive: boolean }
  registeredHost?: string | null
}): { code: string; error: string } | null {
  // Absent means the platform did not answer (older platform, or Cloudflare
  // was unreadable). Unknown is not "missing": let the deploy proceed to the
  // server's authoritative guard.
  if (state.onBehalf?.ownerJwtLive !== false) return null
  // Never deployed at all (no live host) vs. a live deployment predating the
  // owner JWT: the first is the collaborator-first path v0.26.0 opened, and
  // "redeploy"/"existing secrets" named things that had never happened —
  // advice a fresh agent cannot act on (v0.26.0 collab AX).
  if (state.registeredHost == null) {
    return {
      code: 'owner_jwt_missing',
      error:
        'This app has no live deployment to inherit an owner credential from (it has never been ' +
        'deployed, or is currently undeployed). The owner must run `deepspace deploy` first; ' +
        'after that, collaborators can deploy it.',
    }
  }
  return {
    code: 'owner_jwt_missing',
    error:
      'Cannot preserve the existing secrets: this app has no live deployment ' +
      'carrying an APP_OWNER_JWT. Ask the owner to redeploy.',
  }
}

/**
 * The rename this deploy would perform, comparing the wrangler `name` against
 * the host the registry currently serves. Null when nothing moves: no live
 * subdomain yet (first deploy), or the same label.
 */
export function pendingRename(
  registeredHost: string | null | undefined,
  appName: string,
): { fromHost: string; toHost: string } | null {
  if (!registeredHost) return null
  const [label, ...domain] = registeredHost.split('.')
  if (label === appName) return null
  return { fromHost: registeredHost, toHost: [appName, ...domain].join('.') }
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

/** `forbidden` on deploy means the app is registered to another account. */
export function forbiddenDeployMessage(appId: string, token: string): string {
  let who = 'this account'
  let email: string | undefined
  try {
    const claims = decodeJwtPayload<{ email?: string; sub?: string }>(token)
    email = claims.email
    who = email ?? claims.sub ?? who
  } catch {
    // An undecodable bearer still names the app; the account stays generic.
  }
  // `collaborators add` takes an email, so the quoted command is only
  // copyable when the token carries one; otherwise name the step, not a
  // command that would not run.
  const grant = email
    ? `run \`deepspace app collaborators add ${email}\``
    : 'add your email as a collaborator'
  return (
    `${appId} belongs to another account — you are signed in as ${who}, who is neither its owner nor a ` +
    `collaborator. Ask the owner to ${grant} (collaborators can deploy), or log in as the owner; ` +
    `to publish this code as your OWN app instead, run \`deepspace app init --new-id\`.`
  )
}

async function authenticate(
  appDir: string,
  output: DeployOutput,
  minimumValidityMs?: number,
): Promise<{ token: string; ownerId: string }> {
  try {
    const token = await ensureToken({ minimumValidityMs })
    return { token, ownerId: decodeJwtPayload<{ sub: string }>(token).sub }
  } catch (error: unknown) {
    if (errorCode(error) !== 'not_authenticated') throw error
    output.die(errorMessage(error), 'not_authenticated', {
      action: { cwd: appDir, argv: ['deepspace', 'auth', 'login'] },
    })
  }
}
