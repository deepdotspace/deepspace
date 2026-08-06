import * as p from '@clack/prompts'
import { readFileSync } from 'node:fs'
import { printAction, withSlug, type CliAction } from '../../lib/output'
import type { Spinner } from '../../lib/spinner'
import type { DeployAsset, DeployBundle } from './build'
import type { DeployOutput } from './output'
import { shouldSendLineage, type DeployRepositoryState } from './repository'
import type { DeploySecretsPayload } from './secrets'

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
 * The asset-transport contract this CLI speaks. A deploy worker that does not
 * advertise it cannot accept these uploads at all.
 *
 * This is a bespoke handshake because it is the only version gate the CLI has
 * today; the general CLI-staleness check being built alongside it will
 * subsume the "which platform am I talking to" half, leaving this to name the
 * one capability the upload path depends on.
 */
const REQUIRED_ASSET_TRANSPORT = 'content-addressed-v1'

/** Parallel asset uploads. Enough to saturate a normal uplink without
 *  making a failure ambiguous across many in-flight requests. */
const UPLOAD_CONCURRENCY = 4

export interface DeployCommitResponse {
  success?: boolean
  url?: string
  error?: string
  code?: string
  fromHost?: string
  toHost?: string
  onBehalfOfOwner?: string
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
  rename: boolean
  ignoreStale: boolean
  bundle: DeployBundle
  secrets: DeploySecretsPayload
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
    ignoreStale,
    bundle,
    secrets,
    repository,
    output,
    spinner,
  } = options

  spinner.start(`Deploying ${appName}...`)
  if (bundle.extraRoutes === true) {
    p.log.info('Worker-first routing: all requests')
  } else if (bundle.extraRoutes.length) {
    p.log.info(`Custom worker-first routes: ${bundle.extraRoutes.join(', ')}`)
  }

  await requireAssetTransport(deployUrl, spinner, output)
  await uploadDeployAssets({ deployUrl, appId, token, assets: bundle.assets, output, spinner })
  spinner.message(`Deploying ${appName}...`)

  let confirmRename = options.rename
  const bail = async (
    message: string,
    stopLabel: string | null = 'Deploy failed',
    code?: string,
    actionRequired = false,
    action?: CliAction,
  ): Promise<never> => {
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
    process.exit(actionRequired ? 2 : 1)
  }

  const makeForm = (): FormData => {
    const form = new FormData()
    form.append(
      'worker',
      new Blob([bundle.workerJs], { type: 'application/javascript' }),
      'worker.js',
    )
    form.append('assetManifest', JSON.stringify(assetManifest(bundle.assets)))
    form.append('appMigrations', JSON.stringify(bundle.appMigrations))
    if (bundle.doManifest) form.append('doManifest', JSON.stringify(bundle.doManifest))
    if (bundle.customBindings.length) {
      form.append('bindingManifest', JSON.stringify(bundle.customBindings))
    }
    if (secrets.names.length) form.append('userSecrets', JSON.stringify(secrets.values))
    if (bundle.extraRoutes === true || bundle.extraRoutes.length) {
      form.append('extraRunWorkerFirst', JSON.stringify(bundle.extraRoutes))
    }
    if (Object.keys(bundle.assetConfig).length) {
      form.append('assetConfig', JSON.stringify(bundle.assetConfig))
    }
    form.append('name', appName)
    if (confirmRename) form.append('confirmRename', 'true')
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
    if (repository.baseReleaseId) form.append('baseReleaseId', repository.baseReleaseId)
    if (ignoreStale) form.append('ignoreStale', 'true')
    form.append('deployKey', repository.deployKey)
    return form
  }

  const postCommit = async (): Promise<Response> =>
    postWithRetry(
      `${deployUrl}/api/deploy/${appId}`,
      () => ({
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: makeForm(),
      }),
      { retryServerErrors: false },
    )

  let response: Response
  try {
    response = await postCommit()
  } catch (error: unknown) {
    await bail(
      `Deploy request failed: ${errorMessage(error)}`,
      'Deploy failed',
      'deploy_request_failed',
    )
    throw error
  }

  let body = (await response.json().catch(() => ({}))) as DeployCommitResponse

  if (response.status === 409 && body.code === 'rename_required' && !confirmRename) {
    spinner.stop('Rename confirmation needed')
    if (output.nonInteractive) {
      await bail(
        `This deploy renames the app: ${body.fromHost} → ${body.toHost}. ` +
          'Confirmation needs an interactive terminal — re-run with --rename to approve the ' +
          'rename, or `deepspace app init --new-id` if you meant a separate app.',
        null,
        'rename_required',
      )
    }
    const confirmed = await p.confirm({
      message:
        `This deploy renames the app: ${body.fromHost} → ${body.toHost}. ` +
        `The URL changes and the old one stops serving right away; data, secrets, and collaborators travel with it. ` +
        '(Meant a separate app? Run `deepspace app init --new-id` instead.) Rename?',
    })
    if (p.isCancel(confirmed) || !confirmed) await bail('Deploy cancelled.', null)

    confirmRename = true
    spinner.start(`Deploying ${appName}...`)
    response = await postCommit()
    body = (await response.json().catch(() => ({}))) as DeployCommitResponse
  }

  if (response.status === 409 && body.code === 'stale_base') {
    await bail(
      body.error ??
        'A newer release landed while you worked — pull, integrate, and redeploy (or --ignore-stale).',
      'Deploy failed',
      'stale_base',
      true,
      { cwd: appDir, argv: ['deepspace', 'pull'] },
    )
  }
  if (!response.ok || !body.success) {
    await bail(
      formatDeployWorkerError(response.status, body.error, body.code),
      'Deploy failed',
      body.code,
    )
  }

  if (body.onBehalfOfOwner) {
    // The owner's id is the only identity on the wire here, and a collaborator
    // cannot read the owner roster to resolve it — so say the thing that
    // matters (attribution, not you) and leave the id to --json.
    p.log.warn("This release is attributed to the app's owner, not to your account.")
  }
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
  return body
}

export function assetManifest(
  assets: DeployAsset[],
): Array<{ path: string; hash: string; size: number }> {
  return assets.map((asset) => ({ path: asset.path, hash: asset.hash, size: asset.size }))
}

/**
 * Refuse to start against a deploy service that predates this transport.
 * Failing here costs nothing; failing halfway through an upload wastes the
 * user's bandwidth and leaves them guessing.
 */
async function requireAssetTransport(
  deployUrl: string,
  spinner: Spinner,
  output: DeployOutput,
): Promise<void> {
  let advertised: unknown
  try {
    const response = await fetch(`${deployUrl}/api/health`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { capabilities?: { assetTransport?: unknown } }
    advertised = body.capabilities?.assetTransport
  } catch (error: unknown) {
    spinner.stop('Deploy failed')
    output.die(
      `Could not reach the DeepSpace deploy service at ${deployUrl} to check its ` +
        `capabilities: ${errorMessage(error)}`,
      'deploy_service_unreachable',
    )
  }
  if (advertised !== REQUIRED_ASSET_TRANSPORT) {
    spinner.stop('Deploy failed')
    output.die(
      `The DeepSpace deploy service at ${deployUrl} does not support this CLI's asset ` +
        `transport (needs "${REQUIRED_ASSET_TRANSPORT}", found ` +
        `${advertised === undefined ? 'none' : `"${String(advertised)}"`}). ` +
        'Wait for the platform to finish updating, or pin an older deepspace CLI.',
      'asset_transport_unsupported',
    )
  }
}

/** Ask which content the platform is missing, then upload only that. */
export async function uploadDeployAssets(options: {
  deployUrl: string
  appId: string
  token: string
  assets: DeployAsset[]
  output: DeployOutput
  spinner: Spinner
}): Promise<void> {
  const { deployUrl, appId, token, assets, spinner } = options
  // Annotated so `die`'s `never` return still ends control flow here.
  const output: DeployOutput = options.output
  const byHash = new Map(assets.map((asset) => [asset.hash, asset]))

  spinner.message('Checking which assets are already uploaded...')
  let planResponse: Response
  try {
    planResponse = await postWithRetry(`${deployUrl}/api/deploy/${appId}/asset-plan`, () => ({
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assets: [...byHash.values()].map((asset) => ({ hash: asset.hash, size: asset.size })),
      }),
    }))
  } catch (error: unknown) {
    spinner.stop('Deploy failed')
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
      const response = await postWithRetry(
        `${deployUrl}/api/deploy/${appId}/assets/${asset.hash}`,
        () => ({
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
          },
          // Read whole, per attempt. The platform matches Content-Length
          // against the plan before it touches storage, and a stream body
          // would be sent chunked with no length at all; a retry also needs a
          // body it can send again.
          body: readFileSync(asset.sourcePath),
        }),
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

  try {
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, missing.length) }, worker),
    )
  } catch (error: unknown) {
    spinner.stop('Deploy failed')
    if (error instanceof AssetUploadError) {
      output.die(formatDeployWorkerError(error.status, error.message, error.code), error.code)
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
  // The platform's own upgrade instruction is the whole message; wrapping it
  // in incident boilerplate would bury the one action that fixes it.
  if (code === 'cli_outdated') return detail
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

/** Retry rebuilt request bodies on network failures and eligible transient responses. */
export async function postWithRetry(
  url: string,
  makeInit: () => RequestInit,
  {
    attempts = 4,
    retryServerErrors = true,
  }: { attempts?: number; retryServerErrors?: boolean } = {},
): Promise<Response> {
  let lastResponse: Response | undefined
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, makeInit())
      const transient =
        retryServerErrors &&
        (response.status >= 500 || response.status === 408 || response.status === 429)
      if (!transient) return response
      lastResponse = response
    } catch (error) {
      lastError = error
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 500 * 2 ** (attempt - 1))))
    }
  }
  if (lastResponse) return lastResponse
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
