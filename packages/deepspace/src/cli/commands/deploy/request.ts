import * as p from '@clack/prompts'
import { readFileSync } from 'node:fs'
import { ApiError } from '../../lib/api'
import { CliExit } from '../../lib/cli-errors'
import { fetchWithTransientRetry } from '../../lib/fetch-retry'
import { executableAction, printAction, withSlug, type CliAction } from '../../lib/output'
import type { Spinner } from '../../lib/spinner'
import type { DeployAsset, DeployBundle } from './build'
import type { DeployOutput } from './output'
import { shouldSendLineage, type DeployRepositoryState } from './repository'
import { secretsConfigCreateAction } from './secrets'

// Kept as this module's public name for existing callers and tests.
export const postWithRetry = fetchWithTransientRetry

/**
 * Every place a rename leaves the OLD display name behind. The rename moves the
 * host and everything keyed to the app id; these two files still spell the
 * previous name and no deploy rewrites them, so a renamed app serves its old
 * name in its own nav (`src/constants.ts`) and in `env.APP_NAME` (wrangler's
 * `[vars]`) until someone edits them. Both sentences below and the `--rename`
 * success envelope are built from this list, so none of them can drift.
 */
export const STALE_DISPLAY_NAME_LOCATIONS = [
  'src/constants.ts:APP_NAME',
  'wrangler.toml:[vars].APP_NAME',
] as const

/** What a rename does and does not carry. Both sentences below say it — the
 *  half an agent reads used to omit it entirely. */
const RENAME_CONSEQUENCES =
  'The URL changes and the old one stops serving right away; data, secrets, and collaborators ' +
  'travel with it — the display name does NOT: update it yourself in ' +
  `${STALE_DISPLAY_NAME_LOCATIONS.join(' and ')}.`

/**
 * The two rename sentences — ONE source for the pre-build check in deploy.ts
 * and the commit-time 409 path below, so an agent meets the same text either
 * way. Non-interactive refusal:
 */
export function renameRefusalMessage(rename: { fromHost: string; toHost: string }): string {
  return (
    `This deploy renames the app: ${rename.fromHost} → ${rename.toHost}. ` +
    `${RENAME_CONSEQUENCES} ` +
    'Confirmation needs an interactive terminal — re-run with --rename to approve the ' +
    'rename, or `deepspace app init --new-id` if you meant a separate app.'
  )
}

/** Interactive rename confirmation. */
export function renamePromptMessage(rename: { fromHost: string; toHost: string }): string {
  return (
    `This deploy renames the app: ${rename.fromHost} → ${rename.toHost}. ` +
    `${RENAME_CONSEQUENCES} ` +
    '(Meant a separate app? Run `deepspace app init --new-id` instead.) Rename?'
  )
}

const CLOUDFLARE_DEPLOY_ERROR_HINT =
  "Deployment reached the DeepSpace deploy worker, but Cloudflare's deployment " +
  'control-plane API failed. This is often caused by a Cloudflare Dashboard/API ' +
  'incident or Workers for Platforms entitlement outage. Already deployed apps ' +
  'should keep serving; wait for Cloudflare to recover and retry.'

const DEPLOY_SERVICE_LIMIT_HINT =
  'The DeepSpace deploy service hit a resource limit processing this deploy ' +
  '(the deploy worker was terminated before it could answer). This is a ' +
  'DeepSpace-side failure, not a Cloudflare incident — your app was not ' +
  'changed. Retry; if it keeps happening, report the app id and asset count.'

/**
 * The deploy-worker capabilities this CLI hard-requires from /api/health
 * before doing anything. Bespoke handshake pending the general CLI-staleness
 * check; each entry names a protocol, not a version bump.
 *
 *  - assetTransport: the content-addressed plan/stream/manifest upload path.
 *  - secretsSource: the platform reads the app's secrets store at commit (the
 *    form names a config, carries no values). An older server would read the
 *    ABSENCE of the retired `userSecrets` field as an upload carrying no
 *    secret bindings: an owner deploy would strip EVERY live user secret
 *    (only on-behalf deploys keep_bindings them) — so refuse it up front.
 */
const REQUIRED_ASSET_TRANSPORT = 'content-addressed-v1'
const REQUIRED_SECRETS_SOURCE = 'store-read-v1'
const REQUIRED_WORKER_MODULE_TRANSPORT = 'multipart-v1'

/** Parallel asset uploads. Small files pay a full round trip each, so the
 *  pool width — not bandwidth — dominates a many-file first deploy (474
 *  files at width 4 measured ~3 minutes; the bytes were 22 MiB). The asset
 *  PUT route applies no server-side rate limit. */
const UPLOAD_CONCURRENCY = 16

/**
 * Asset bodies can legitimately spend minutes in flight on constrained links.
 * Keep control-plane requests on the shared one-minute bound, but give each
 * replayable content-addressed PUT a generous budget. Two 150-second attempts
 * keep the complete failure bound near five minutes instead of multiplying a
 * five-minute allowance by the shared four-attempt default.
 */
export const ASSET_UPLOAD_ATTEMPT_TIMEOUT_MS = 150_000
export const ASSET_UPLOAD_ATTEMPTS = 2

export type DeployTokenRefresh = () => Promise<string | null>

interface DeployAuthSession {
  request(run: (token: string) => Promise<Response>): Promise<Response>
}

/**
 * Retry exactly one server-confirmed 401 with one freshly exchanged bearer.
 * Concurrent asset requests share the refresh promise, so an expired token
 * causes one session exchange rather than an authentication stampede.
 */
function createDeployAuthSession(
  initialToken: string,
  refreshToken: DeployTokenRefresh | undefined,
): DeployAuthSession {
  let currentToken = initialToken
  let refreshInFlight: Promise<string | null> | null = null

  const recover = async (rejectedToken: string): Promise<string | null> => {
    if (currentToken !== rejectedToken) return currentToken
    if (!refreshToken) return null
    if (!refreshInFlight) {
      refreshInFlight = refreshToken()
        .then((freshToken) => {
          if (freshToken && freshToken !== currentToken) currentToken = freshToken
          return freshToken
        })
        .finally(() => {
          refreshInFlight = null
        })
    }
    return await refreshInFlight
  }

  return {
    async request(run): Promise<Response> {
      const rejectedToken = currentToken
      const response = await run(rejectedToken)
      if (response.status !== 401) return response
      const freshToken = await recover(rejectedToken)
      return freshToken && freshToken !== rejectedToken ? await run(freshToken) : response
    },
  }
}

export interface DeployCommitResponse {
  success?: boolean
  url?: string
  error?: string
  code?: string
  fromHost?: string
  toHost?: string
  /** Client-observed, not from the wire: the host this call renamed away from,
   *  set only when the rename was settled by the commit-time 409 below (an
   *  older platform that sends no `registeredHost`, so deploy's pre-build check
   *  could not see it coming). deploy.ts reports the rename from whichever of
   *  the two paths fired. */
  renamedFrom?: string
  staleBaseGuard?: string
  releaseId?: string
  bundleRetained?: boolean
  /** This upload's release-stamp nonce; lets the wait prove WHICH release the
   *  edge serves. Absent from an older platform or a resumed activation. */
  releaseStamp?: string
}

export async function deployBuiltBundle(options: {
  deployUrl: string
  appDir: string
  appId: string
  appName: string
  token: string
  refreshToken?: DeployTokenRefresh
  rename: boolean
  claimReleased: boolean
  ignoreStale: boolean
  bundle: DeployBundle
  /** Name of the secrets config the platform reads at commit. */
  secretsConfig: string
  envName: string | undefined
  repository: DeployRepositoryState
  output: DeployOutput
  spinner: Spinner
}): Promise<DeployCommitResponse> {
  const {
    deployUrl,
    appDir,
    appId,
    appName,
    token,
    refreshToken,
    claimReleased,
    ignoreStale,
    bundle,
    secretsConfig,
    envName,
    repository,
    output,
    spinner,
  } = options
  const auth = createDeployAuthSession(token, refreshToken)

  spinner.start(`Deploying ${appName}...`)
  if (bundle.extraRoutes === true) {
    p.log.info('Worker-first routing: all requests')
  } else if (bundle.extraRoutes.length) {
    p.log.info(`Custom worker-first routes: ${bundle.extraRoutes.join(', ')}`)
  }

  // The unconditional capability gate (assetTransport + secretsSource) runs
  // in deploy.ts BEFORE the secrets refresh, the build, and the repo push —
  // failing there costs nothing. Only the workerModules arm waits here: it
  // cannot be decided before the built bundle says whether the Vite graph
  // emitted imported Worker chunks.
  await requireWorkerModulesCapability(deployUrl, bundle.worker.modules.length > 1, spinner, output)
  await uploadDeployAssetsWithAuth(
    { deployUrl, appId, assets: bundle.assets, output, spinner },
    auth,
  )
  spinner.message(`Deploying ${appName}...`)

  let confirmRename = options.rename
  const bail = async (
    message: string,
    stopLabel: string | null = 'Deploy failed',
    code?: string,
    actionRequired = false,
    rawAction?: CliAction,
  ): Promise<never> => {
    // Deploy's post-upload exit door pins like die() does — a bare
    // `deepspace` argv must never leave here.
    const action = rawAction ? executableAction(rawAction) : undefined
    if (stopLabel !== null) spinner.stop(stopLabel)
    p.cancel(code ? withSlug(message, code) : message)
    if (action) printAction(action)
    if (output.json) {
      output.emitJson({
        ok: false,
        ...(actionRequired ? { actionRequired: true } : {}),
        error: message,
        ...(code ? { code } : {}),
        ...(action ? { action } : {}),
      })
    }
    // Throw, never process.exit(): the deploy POST/uploads above leave undici
    // connections that make an exit() abort on Windows (see lib/command.ts).
    // The sentinel unwinds to wrapCommandErrors → renderCliError, which
    // records the exit code without re-rendering.
    throw new CliExit(actionRequired ? 2 : 1)
  }

  const makeForm = (): FormData => {
    const form = new FormData()
    const main = bundle.worker.modules.find((module) => module.name === bundle.worker.main)
    if (!main) return output.die('Built Worker bundle has no main module.', 'build_output_invalid')
    form.append(
      'worker',
      new Blob([main.content], { type: 'application/javascript+module' }),
      main.name,
    )
    form.append('workerMain', bundle.worker.main)
    const additionalModules = bundle.worker.modules.filter(
      (module) => module.name !== bundle.worker.main,
    )
    if (additionalModules.length) {
      form.append('workerModules', JSON.stringify(additionalModules.map((module) => module.name)))
      for (const module of additionalModules) {
        form.append(
          'workerModule',
          new Blob([module.content], { type: 'application/javascript+module' }),
          module.name,
        )
      }
    }
    form.append('assetManifest', JSON.stringify(assetManifest(bundle.assets)))
    form.append('appMigrations', JSON.stringify(bundle.appMigrations))
    if (bundle.doManifest) form.append('doManifest', JSON.stringify(bundle.doManifest))
    if (bundle.customBindings.length) {
      form.append('bindingManifest', JSON.stringify(bundle.customBindings))
    }
    form.append('secretsConfig', secretsConfig)
    if (bundle.extraRoutes === true || bundle.extraRoutes.length) {
      form.append('extraRunWorkerFirst', JSON.stringify(bundle.extraRoutes))
    }
    if (Object.keys(bundle.assetConfig).length) {
      form.append('assetConfig', JSON.stringify(bundle.assetConfig))
    }
    if (bundle.compatibilityDate) {
      form.append('compatibilityDate', bundle.compatibilityDate)
    }
    if (bundle.compatibilityFlags.length) {
      form.append('compatibilityFlags', JSON.stringify(bundle.compatibilityFlags))
    }
    if (bundle.notFoundHandling) {
      form.append('notFoundHandling', bundle.notFoundHandling)
    }
    form.append('name', appName)
    if (confirmRename) form.append('confirmRename', 'true')
    if (claimReleased) form.append('claimReleased', 'true')
    if (shouldSendLineage(repository.commitOid, repository.recoverable)) {
      form.append('commitOid', repository.commitOid as string)
    }
    if (repository.source) {
      form.append('sourceProvider', repository.source.provider)
      form.append('sourceRevision', String(repository.sourceRevision))
      if (repository.source.provider === 'github') {
        form.append('sourceRepository', repository.source.repository)
      }
    }
    // A GitHub-source release records no commit, so this flag is the ledger's
    // only trace of whether the shipped tree was clean — without it a dirty
    // deploy and a clean one are indistinguishable in `releases`, and a
    // rollback picks between them blind.
    if (repository.dirty !== null) form.append('sourceDirty', repository.dirty ? 'true' : 'false')
    // Inferred-GitHub evidence rides its own field (never `sourceProvider`,
    // which a 0.25.0 worker would trust as claimed source and skip its stale
    // guard on); an older worker simply ignores it.
    if (repository.observedRepository) {
      form.append('observedRepository', repository.observedRepository)
    }
    if (ignoreStale) form.append('ignoreStale', 'true')
    form.append('deployKey', repository.deployKey)
    return form
  }

  // The commit does real provisioning work server-side, so its bound is
  // generous — but it exists, and a timed-out attempt retries once rather
  // than three times: a re-POST records another release, so hammering a
  // slow service multiplies ledger rows for one intent.
  let commitStarted = Date.now()
  const postCommit = async (): Promise<Response> => {
    commitStarted = Date.now()
    return auth.request((bearer) =>
      postWithRetry(
        `${deployUrl}/api/deploy/${appId}`,
        () => ({
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          body: makeForm(),
        }),
        { retryServerErrors: false, attempts: 2, timeoutMs: 240_000 },
      ),
    )
  }

  let response: Response
  try {
    response = await postCommit()
  } catch (error: unknown) {
    await bail(
      error instanceof ApiError
        ? errorMessage(error)
        : `Deploy request failed: ${errorMessage(error)}`,
      'Deploy failed',
      error instanceof ApiError ? error.code : 'deploy_request_failed',
    )
    throw error
  }

  let body = (await response.json().catch(() => ({}))) as DeployCommitResponse
  let renamedFrom: string | undefined

  if (response.status === 409 && body.code === 'rename_required' && !confirmRename) {
    spinner.stop('Rename confirmation needed')
    const rename = { fromHost: body.fromHost ?? '', toHost: body.toHost ?? '' }
    if (output.nonInteractive) {
      await bail(renameRefusalMessage(rename), null, 'rename_required')
    }
    const confirmed = await p.confirm({ message: renamePromptMessage(rename) })
    if (p.isCancel(confirmed) || !confirmed) await bail('Deploy cancelled.', null)

    confirmRename = true
    renamedFrom = rename.fromHost
    spinner.start(`Deploying ${appName}...`)
    response = await postCommit()
    body = (await response.json().catch(() => ({}))) as DeployCommitResponse
  }

  if (response.status === 409 && body.code === 'stale_base') {
    // NO action, deliberately: the recoveries are a DECISION — integrate the
    // live tip (`pull` when it lives on trunk, `workspace land` when it came
    // from a workspace branch), or `--ignore-stale` to replace it. The old
    // `deepspace pull` action looped forever after a workspace-branch
    // release: pull answered up_to_date (the live commit sits on a ws/* ref
    // trunk can never fast-forward to) and the next deploy refused
    // identically — two r2 AX lanes hit it independently. Per the contract,
    // a refusal naming a choice ships no action — but it KEEPS exit 2 /
    // `actionRequired: true`: a local step remains (which one is the
    // decision), and demoting it to exit 1 reads as a hard failure to
    // wrappers built on the three-exit contract.
    await bail(
      body.error ??
        'A newer release landed while you worked. Integrate it — `deepspace pull` when the live ' +
          'commit is on trunk, or land/`--ignore-stale` past a workspace-branch release — then redeploy.',
      'Deploy failed',
      'stale_base',
      true,
    )
  }
  // Backstop for the race the early check can't see: the config existed when
  // loadDeploySecrets looked but was deleted before the server's commit-time
  // read. Same executable fix as the early refusal.
  if (response.status === 409 && body.code === 'secrets_config_missing') {
    // Our own sentence, not body.error: the server cannot know the wrangler
    // env, so its embedded remedy prose lacks --env and, followed as
    // printed, would create the config on the WRONG app (--env = separate
    // app). The structured action below is the same fix, env-aware.
    await bail(
      `Secrets config "${secretsConfig}" does not exist on the platform (it was ` +
        'deleted after the pre-deploy check). Create it explicitly before deploying' +
        (envName
          ? ` (run the action below — plain \`configs create\` targets the top-level app)`
          : '') +
        '.',
      'Deploy failed',
      'secrets_config_missing',
      true,
      secretsConfigCreateAction(appDir, secretsConfig, envName),
    )
  }
  // Another deploy of this app (from another checkout — the local lock rules
  // out this one) is between prepared and live. Nothing here is wrong and
  // nothing needs changing: retrying once it lands is the whole remedy, so
  // this is the "your turn" tier (exit 2) with the retry as the action, not
  // a hard failure that tells an agent to stop retrying.
  if (response.status === 409 && body.code === 'release_in_progress') {
    await bail(
      `${body.error ?? 'Another deploy of this app is already in progress'}. It is committing now — ` +
        'this run built and uploaded fine but did not release. Wait a moment and run the same deploy ' +
        'again; if it keeps refusing for more than a couple of minutes, check `deepspace releases`.',
      'Deploy failed',
      'release_in_progress',
      true,
      { cwd: process.cwd(), argv: ['deepspace', ...process.argv.slice(2)] },
    )
  }
  if (!response.ok || !body.success) {
    // Cloudflare control-plane failures reach us as prose with no `code` — but
    // the machine contract promises a stable code on every refusal, and this is
    // the commonest failure an agent meets. Keep the server's code when it
    // sends one; otherwise name the phase.
    await bail(
      formatDeployWorkerError(response.status, body.error, body.code),
      'Deploy failed',
      body.code ?? 'deploy_failed',
    )
  }

  p.log.info(`Platform commit: ${Math.round((Date.now() - commitStarted) / 1000)}s`)

  // No on-behalf attribution warning: it claimed the release was attributed to
  // the owner, and the ledger records the opposite — the deploy worker writes
  // the release `actor` from the CALLER's user id (routes/deploy/preflight.ts
  // keeps `userId` as the caller and only `ownerUserId` is overridden), which
  // is why `releases --json` names the collaborator and `status --json` reads
  // `byYou: true` for them. The warning was simply false.
  if (body.staleBaseGuard === 'skipped') {
    p.log.warn(
      'The stale-base guard was skipped (repo store unavailable) — this deploy was NOT ' +
        "checked against the live release. Verify you're not clobbering newer work.",
    )
  }
  if (body.bundleRetained === false) {
    p.log.warn(
      'This deploy is live, but its rollback bundle was not retained because the app storage quota is full.',
    )
  }
  return renamedFrom ? { ...body, renamedFrom } : body
}

export function assetManifest(
  assets: DeployAsset[],
): Array<{ path: string; hash: string; size: number }> {
  return assets.map((asset) => ({ path: asset.path, hash: asset.hash, size: asset.size }))
}

/**
 * Refuse to start against a deploy service missing a required capability.
 * Failing here costs nothing; failing halfway through an upload wastes the
 * user's bandwidth — and an old server would misread the new secrets shape
 * silently rather than fail at all.
 */
/** Stateless by design: the post-build workerModules arm re-probes rather
 *  than sharing module state with the pre-build gate — one extra bounded GET,
 *  only on multi-module builds, and nothing to reset between tests. */
type DeployCapabilities = {
  assetTransport?: unknown
  secretsSource?: unknown
  workerModules?: unknown
}

async function probeDeployCapabilities(
  deployUrl: string,
  spinner: Spinner | null,
  output: DeployOutput,
): Promise<DeployCapabilities> {
  let capabilities: DeployCapabilities = {}
  try {
    // Bounded and retried like every other deploy call — otherwise one
    // transient blip hard-refuses the deploy and a hung service stalls the
    // CLI for undici's ~5 minutes.
    const response = await postWithRetry(`${deployUrl}/api/health`, () => ({}), {
      attempts: 2,
      timeoutMs: 10_000,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { capabilities?: DeployCapabilities }
    capabilities = body.capabilities ?? {}
  } catch (error: unknown) {
    spinner?.stop('Deploy failed')
    output.die(
      `Could not reach the DeepSpace deploy service at ${deployUrl} to check its ` +
        `capabilities: ${errorMessage(error)}`,
      'deploy_service_unreachable',
    )
  }
  return capabilities
}

function requireCapability(
  deployUrl: string,
  spinner: Spinner | null,
  output: DeployOutput,
  name: string,
  advertised: unknown,
  required: string,
  code: string,
  // Only arms where an older CLI actually helps name a version — pinning
  // the last pre-cutover CLI (0.23) fixes a missing secretsSource, but it
  // requires assetTransport just the same, so that arm must not suggest it.
  pinHint = '',
): void {
  if (advertised === required) return
  spinner?.stop('Deploy failed')
  output.die(
    `The DeepSpace deploy service at ${deployUrl} does not support this CLI's ${name} ` +
      `(needs "${required}", found ` +
      `${advertised === undefined ? 'none' : `"${String(advertised)}"`}). ` +
      `Wait for the platform to finish updating${pinHint}.`,
    code,
  )
}

/** The unconditional arms, hoisted pre-cost: deploy.ts calls this BEFORE the
 *  secrets refresh, the build, and the repo push. */
export async function requireDeployCapabilities(
  deployUrl: string,
  spinner: Spinner | null,
  output: DeployOutput,
): Promise<void> {
  const capabilities = await probeDeployCapabilities(deployUrl, spinner, output)
  requireCapability(
    deployUrl,
    spinner,
    output,
    'asset transport',
    capabilities.assetTransport,
    REQUIRED_ASSET_TRANSPORT,
    'asset_transport_unsupported',
  )
  requireCapability(
    deployUrl,
    spinner,
    output,
    'secrets source',
    capabilities.secretsSource,
    REQUIRED_SECRETS_SOURCE,
    'secrets_source_unsupported',
    ', or pin the last pre-cutover CLI (`npm i -g deepspace@0.23`)',
  )
}

/** The one arm that needs the BUILT bundle: whether the Vite graph emitted
 *  imported Worker chunks cannot be known pre-build, so it gates here. */
export async function requireWorkerModulesCapability(
  deployUrl: string,
  needsWorkerModules: boolean,
  spinner: Spinner | null,
  output: DeployOutput,
): Promise<void> {
  if (!needsWorkerModules) return
  const capabilities = await probeDeployCapabilities(deployUrl, spinner, output)
  if (capabilities.workerModules !== REQUIRED_WORKER_MODULE_TRANSPORT) {
    spinner?.stop('Deploy failed')
    output.die(
      `This build contains multiple Worker modules, but the DeepSpace deploy service at ` +
        `${deployUrl} does not support their transport (needs ` +
        `"${REQUIRED_WORKER_MODULE_TRANSPORT}", found ` +
        `${capabilities.workerModules === undefined ? 'none' : `"${String(capabilities.workerModules)}"`}). ` +
        'Wait for the platform to finish updating before retrying this deploy.',
      'worker_module_transport_unsupported',
    )
  }
}

/** Ask which content the platform is missing, then upload only that. */
interface UploadDeployAssetsOptions {
  deployUrl: string
  appId: string
  assets: DeployAsset[]
  output: DeployOutput
  spinner: Spinner
}

export async function uploadDeployAssets(
  options: UploadDeployAssetsOptions & {
    token: string
    refreshToken?: DeployTokenRefresh
  },
): Promise<void> {
  return await uploadDeployAssetsWithAuth(
    options,
    createDeployAuthSession(options.token, options.refreshToken),
  )
}

async function uploadDeployAssetsWithAuth(
  options: UploadDeployAssetsOptions,
  auth: DeployAuthSession,
): Promise<void> {
  const { deployUrl, appId, assets, spinner } = options
  // Annotated so `die`'s `never` return still ends control flow here.
  const output: DeployOutput = options.output
  const byHash = new Map(assets.map((asset) => [asset.hash, asset]))

  spinner.message('Checking which assets are already uploaded...')
  let planResponse: Response
  try {
    planResponse = await auth.request((bearer) =>
      postWithRetry(`${deployUrl}/api/deploy/${appId}/asset-plan`, () => ({
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assets: [...byHash.values()].map((asset) => ({ hash: asset.hash, size: asset.size })),
        }),
      })),
    )
  } catch (error: unknown) {
    spinner.stop('Deploy failed')
    if (error instanceof ApiError) {
      output.die(errorMessage(error), error.code ?? 'upload_failed')
    }
    output.die(`Asset plan failed (network): ${errorMessage(error)}`, 'upload_failed')
  }
  const planBody = (await planResponse.json().catch(() => ({}))) as {
    missing?: string[]
    error?: string
    code?: string
  }
  if (!planResponse.ok) {
    spinner.stop('Deploy failed')
    output.die(
      formatDeployWorkerError(planResponse.status, planBody.error, planBody.code),
      planBody.code ?? 'upload_failed',
    )
  }

  const missing: DeployAsset[] = []
  for (const hash of planBody.missing ?? []) {
    const asset = byHash.get(hash)
    // The plan can only name content this build declared. Anything else means
    // the two sides disagree about what is being deployed, and quietly
    // skipping it would ship an app missing a file.
    if (!asset) {
      spinner.stop('Deploy failed')
      output.die(
        `The deploy service asked for asset ${hash}, which is not part of this build. ` +
          'Re-run the deploy; if it persists, report the app id.',
        'upload_failed',
      )
    }
    missing.push(asset)
  }
  if (missing.length === 0) {
    p.log.info(`Assets: ${byHash.size} file(s), all already uploaded`)
    return
  }
  const missingBytes = missing.reduce((total, asset) => total + asset.size, 0)
  p.log.info(
    `Assets: ${byHash.size} file(s), uploading ${missing.length} ` +
      `(${Math.ceil(missingBytes / 1024)} KiB); the rest are already stored`,
  )

  // Snapshot the total before the pool starts draining `missing`: `pop()`
  // removes an asset when a worker CLAIMS it, so `missing.length` counts only
  // unclaimed work and a denominator derived from it climbs alongside the
  // numerator (…, 29/29, 30/30).
  const total = missing.length
  let uploaded = 0
  const next = (): DeployAsset | undefined => missing.pop()
  const worker = async (): Promise<void> => {
    for (let asset = next(); asset; asset = next()) {
      const response = await auth.request((bearer) =>
        postWithRetry(
          `${deployUrl}/api/deploy/${appId}/assets/${asset.hash}`,
          () => ({
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${bearer}`,
              'Content-Type': 'application/octet-stream',
            },
            // Read whole, per attempt. The platform matches Content-Length
            // against the plan before it touches storage, and a stream body
            // would be sent chunked with no length at all; a retry also needs a
            // body it can send again.
            body: readFileSync(asset.sourcePath),
          }),
          { attempts: ASSET_UPLOAD_ATTEMPTS, timeoutMs: ASSET_UPLOAD_ATTEMPT_TIMEOUT_MS },
        ),
      )
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string }
        throw new AssetUploadError(
          body.error ?? `Upload of ${asset.path} failed: HTTP ${response.status}`,
          body.code ?? 'upload_failed',
          response.status,
        )
      }
      uploaded++
      spinner.message(`Uploading assets — ${uploaded}/${total}...`)
    }
  }

  const uploadStarted = Date.now()
  try {
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, missing.length) }, worker))
    p.log.info(`Uploaded ${total} file(s) in ${Math.round((Date.now() - uploadStarted) / 1000)}s`)
  } catch (error: unknown) {
    spinner.stop('Deploy failed')
    if (error instanceof AssetUploadError) {
      output.die(formatDeployWorkerError(error.status, error.message, error.code), error.code)
    }
    if (error instanceof ApiError) {
      output.die(errorMessage(error), error.code ?? 'upload_failed')
    }
    output.die(`Asset upload failed (network): ${errorMessage(error)}`, 'upload_failed')
  }
}

class AssetUploadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * Cloudflare's 1101/1102 interstitials are HTML from the edge, not a relayed
 * API error: they mean OUR deploy worker died (exception or CPU/memory limit).
 * Reporting them as a Cloudflare incident sent users to a status page for a
 * DeepSpace bug, so they get their own message.
 */
export function isDeployServiceResourceLimit(status: number, error: string | undefined): boolean {
  if (!error) return status === 500 || status === 502
  return /\b110[12]\b/.test(error) && /worker|error code/i.test(error)
}

export function formatDeployWorkerError(
  status: number,
  error: string | undefined,
  code?: string,
): string {
  const detail = error ?? `Deployment error (${status})`
  // The platform's own instruction is the whole message; wrapping it in
  // incident boilerplate would bury the one action that fixes it. The 503s
  // secrets_read_failed (DeepSpace store fault) and
  // release_reconciliation_pending ("rerun the same deploy unchanged" is the
  // server's whole instruction) are not Cloudflare incidents — the same
  // misattribution the 1101/1102 guard below exists to prevent.
  if (
    code === 'cli_outdated' ||
    code === 'secrets_read_failed' ||
    code === 'release_reconciliation_pending'
  ) {
    return detail
  }
  if (isDeployServiceResourceLimit(status, error)) {
    return `${DEPLOY_SERVICE_LIMIT_HINT}\n\nUnderlying error: ${detail}`
  }
  if (
    status < 500 &&
    ![
      'Upload session failed',
      'Asset upload failed',
      'Worker deploy failed',
      'entitlements.not_available',
      'Internal Server Error',
    ].some((needle) => error?.includes(needle))
  ) {
    return detail
  }
  return `${CLOUDFLARE_DEPLOY_ERROR_HINT}\n\nUnderlying error: ${detail}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
