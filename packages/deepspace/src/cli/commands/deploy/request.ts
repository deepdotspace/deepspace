import * as p from '@clack/prompts'
import { randomUUID } from 'node:crypto'
import { printAction, withSlug, type CliAction } from '../../lib/output'
import type { Spinner } from '../../lib/spinner'
import type { DeployBundle } from './build'
import type { DeployOutput } from './output'
import { shouldSendLineage, type DeployRepositoryState } from './repository'
import type { DeploySecretsPayload } from './secrets'

const CLOUDFLARE_DEPLOY_ERROR_HINT =
  "Deployment reached the DeepSpace deploy worker, but Cloudflare's deployment " +
  'control-plane API failed. This is often caused by a Cloudflare Dashboard/API ' +
  'incident or Workers for Platforms entitlement outage. Already deployed apps ' +
  'should keep serving; wait for Cloudflare to recover and retry.'

const MAX_GROUP_BYTES = 40 * 1024 * 1024
const GROUP_BYTES = (() => {
  const configured = Number(process.env.DEEPSPACE_DEPLOY_GROUP_BYTES)
  const bytes = Number.isInteger(configured) && configured > 0 ? configured : 3 * 1024 * 1024
  return Math.min(bytes, MAX_GROUP_BYTES)
})()

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
  if (bundle.extraRoutes.length) {
    p.log.info(`Custom worker-first routes: ${bundle.extraRoutes.join(', ')}`)
  }
  const assetGroups = packAssetGroups(bundle.assets, GROUP_BYTES)
  if (assetGroups.length === 0) assetGroups.push([])
  const uploadId = randomUUID()
  const totalGroups = assetGroups.length
  try {
    for (let index = 0; index < totalGroups; index++) {
      const groupJson = JSON.stringify(assetGroups[index])
      spinner.message(`Uploading assets — group ${index + 1}/${totalGroups}...`)
      const groupResponse = await postWithRetry(
        `${deployUrl}/api/deploy/${appId}/assets` +
          `?uploadId=${uploadId}&groupIndex=${index}&totalGroups=${totalGroups}`,
        () => ({
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: groupJson,
        }),
      )
      if (!groupResponse.ok) {
        const errorBody = (await groupResponse.json().catch(() => ({}))) as { error?: string }
        await abortStagedUpload(deployUrl, appId, uploadId, totalGroups, token)
        spinner.stop('Deploy failed')
        output.die(
          `Asset upload failed on group ${index + 1}/${totalGroups}: ` +
            `${errorBody.error ?? `HTTP ${groupResponse.status}`}`,
          'upload_failed',
        )
      }
    }
  } catch (error: unknown) {
    await abortStagedUpload(deployUrl, appId, uploadId, totalGroups, token)
    spinner.stop('Deploy failed')
    output.die(`Asset upload failed (network): ${errorMessage(error)}`, 'upload_failed')
  }
  spinner.message(`Deploying ${appName}...`)

  let confirmRename = options.rename
  const bail = async (
    message: string,
    stopLabel: string | null = 'Deploy failed',
    code?: string,
    actionRequired = false,
    action?: CliAction,
  ): Promise<never> => {
    await abortStagedUpload(deployUrl, appId, uploadId, totalGroups, token)
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
    form.append('uploadId', uploadId)
    form.append('totalGroups', String(totalGroups))
    if (bundle.doManifest) form.append('doManifest', JSON.stringify(bundle.doManifest))
    if (bundle.customBindings.length) {
      form.append('bindingManifest', JSON.stringify(bundle.customBindings))
    }
    if (secrets.names.length) form.append('userSecrets', JSON.stringify(secrets.values))
    if (bundle.extraRoutes.length) {
      form.append('extraRunWorkerFirst', JSON.stringify(bundle.extraRoutes))
    }
    form.append('name', appName)
    if (confirmRename) form.append('confirmRename', 'true')
    if (shouldSendLineage(repository.commitOid, repository.recoverable)) {
      form.append('commitOid', repository.commitOid as string)
    }
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
  for (
    let attempt = 0;
    response.status === 503 && body.code === 'release_finalization_pending' && attempt < 3;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
    response = await postCommit()
    body = (await response.json().catch(() => ({}))) as DeployCommitResponse
  }

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
    await bail(formatDeployWorkerError(response.status, body.error), 'Deploy failed', body.code)
  }

  if (body.onBehalfOfOwner) {
    p.log.warn(`Deployed on behalf of owner ${body.onBehalfOfOwner}`)
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

async function abortStagedUpload(
  deployUrl: string,
  appId: string,
  uploadId: string,
  totalGroups: number,
  token: string,
): Promise<void> {
  try {
    await fetch(
      `${deployUrl}/api/deploy/${appId}/assets` +
        `?uploadId=${uploadId}&totalGroups=${totalGroups}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    )
  } catch {
    // Staged groups are also covered by the R2 lifecycle rule.
  }
}

function formatDeployWorkerError(status: number, error: string | undefined): string {
  const detail = error ?? `Deployment error (${status})`
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

/** Pack whole asset entries into request groups under the serialized byte cap. */
export function packAssetGroups<T>(assets: T[], maxBytes: number): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  let currentBytes = 2
  for (const asset of assets) {
    const entryBytes = Buffer.byteLength(JSON.stringify(asset), 'utf-8') + 1
    if (current.length > 0 && currentBytes + entryBytes > maxBytes) {
      groups.push(current)
      current = []
      currentBytes = 2
    }
    current.push(asset)
    currentBytes += entryBytes
  }
  if (current.length > 0) groups.push(current)
  return groups
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
