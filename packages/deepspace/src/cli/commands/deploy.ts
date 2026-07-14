/**
 * deepspace deploy
 *
 * Builds the app with Vite (Cloudflare plugin bundles both client + worker),
 * then uploads to the deploy worker which handles Cloudflare WfP deployment.
 *
 * Uses the same build pipeline as dev for full fidelity. Reads the output
 * wrangler.json (via .wrangler/deploy/config.json) to find the built assets
 * and worker bundle — the same contract that `wrangler deploy` uses.
 */

import { defineCommand } from 'citty'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as p from '@clack/prompts'
import { createSpinner } from '../lib/spinner'
import { ensureInstallReady } from '../lib/install-status'
import { preflightNodeVersion } from '../lib/preflight'
import { removeMacosJunk } from '../lib/macos-junk'
import { ensureToken } from '../auth'
import { PLATFORM_URLS, extractCustomDevVars, parseDevVars, writeDevVars } from '../env'
import { decodeJwtPayload } from '../jwt'
import {
  type PulledSecretsCache,
  refreshSecretsCache,
  stripGeneratedSecretsCache,
} from '../lib/secrets'
import { mintAppId, readAppId, resolveExistingAppId, writeAppId } from '../lib/app-identity'
import {
  bindingManifestFromOutputConfig,
  validateBindingManifest,
  RESERVED_BINDING_NAMES,
} from '../../server/rooms/binding-manifest'
import {
  resolveAppNameForEnv,
  devVarsPathFor,
  readWranglerConfig,
  hasWranglerConfig,
  prepareWranglerEnvConfig,
  wranglerViteEnv,
  type PreparedWranglerEnvConfig,
  type WranglerConfig,
} from '../lib/wrangler-env'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy
const API_URL = process.env.DEEPSPACE_API_URL ?? PLATFORM_URLS.api

const CLOUDFLARE_DEPLOY_ERROR_HINT =
  "Deployment reached the DeepSpace deploy worker, but Cloudflare's deployment " +
  'control-plane API failed. This is often caused by a Cloudflare Dashboard/API ' +
  'incident or Workers for Platforms entitlement outage. Already deployed apps ' +
  'should keep serving; wait for Cloudflare to recover and retry.'

/**
 * SDK-reserved `run_worker_first` prefixes. Apps can't override or
 * shadow these; only declare additional patterns. The CLI strips the
 * reserved ones before forwarding so the platform never sees them
 * twice — keeps the deploy-side merge a clean set-union.
 */
const RESERVED_RUN_WORKER_FIRST = new Set([
  '/api/*',
  '/ws/*',
  '/internal/*',
  '/v1/*',
  '/_deepspace/*',
])

function extractRunWorkerFirst(cfg: { assets?: { run_worker_first?: unknown } }): string[] {
  const raw = cfg.assets?.run_worker_first
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed.startsWith('/')) continue
    if (RESERVED_RUN_WORKER_FIRST.has(trimmed)) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isLikelyCloudflareDeployFailure(status: number, error: string | undefined): boolean {
  if (status >= 500) return true
  if (!error) return false
  return [
    'Upload session failed',
    'Asset upload failed',
    'Worker deploy failed',
    'entitlements.not_available',
    'Internal Server Error',
  ].some((needle) => error.includes(needle))
}

function formatDeployWorkerError(status: number, error: string | undefined): string {
  const detail = error ?? `Deployment error (${status})`
  if (!isLikelyCloudflareDeployFailure(status, error)) return detail
  return `${CLOUDFLARE_DEPLOY_ERROR_HINT}\n\nUnderlying error: ${detail}`
}

/**
 * Must stay <= the deploy worker's MAX_UPLOAD_GROUP_BYTES, otherwise the worker
 * rejects a group with a 413 that postWithRetry won't retry (it's a 4xx),
 * dead-ending the deploy. The DEEPSPACE_DEPLOY_GROUP_BYTES override is clamped
 * to this.
 */
const MAX_GROUP_BYTES = 40 * 1024 * 1024

/**
 * Soft cap on the serialized size of one asset *group*. We pack whole asset
 * entries into groups under this size and POST each group on its own, so no
 * single request carries the entire payload (a ~40MB+ body stalls and gets
 * reset mid-upload on a marginal uplink: `write EPIPE`). A single asset larger
 * than this is sent alone in its own group — we never split an individual
 * asset. Overridable via DEEPSPACE_DEPLOY_GROUP_BYTES, clamped to MAX_GROUP_BYTES.
 */
const GROUP_BYTES = (() => {
  const raw = Number(process.env.DEEPSPACE_DEPLOY_GROUP_BYTES)
  const v = Number.isInteger(raw) && raw > 0 ? raw : 3 * 1024 * 1024
  return Math.min(v, MAX_GROUP_BYTES)
})()

/**
 * Decide how deploy should react to hand-edited `.dev.vars` secrets relative to
 * the store, which is the single source of truth for what a deploy ships.
 *
 * The dangerous case (see the secrets-source-of-truth work): the store ships
 * NOTHING but `.dev.vars` holds hand-edited secrets. Deploying then ships the
 * app with an empty secret set, replacing any secrets a previous deploy set —
 * silently dropping them from production. We block that (overridable with
 * `--allow-missing-secrets`) rather than only warning after the fact. When the
 * store already ships some secrets, extra local-only `.dev.vars` entries are a
 * benign warning (they're a local dev cache, not deploy config).
 *
 * Pure + exported for tests.
 */
export function classifyDevVarsSecrets(opts: {
  storeSecretNames: string[]
  handEditedDevVarKeys: string[]
  allowMissing: boolean
}): { kind: 'ok' } | { kind: 'warn'; strayKeys: string[] } | { kind: 'block'; strayKeys: string[] } {
  const store = new Set(opts.storeSecretNames)
  const strayKeys = opts.handEditedDevVarKeys.filter((k) => !store.has(k))
  if (strayKeys.length === 0) return { kind: 'ok' }
  if (opts.storeSecretNames.length === 0 && !opts.allowMissing) return { kind: 'block', strayKeys }
  return { kind: 'warn', strayKeys }
}

/**
 * Pack whole asset entries into groups whose serialized JSON stays under
 * `maxBytes`. We never split an individual asset across groups, so a single
 * asset larger than `maxBytes` becomes its own (oversized) group.
 */
export function packAssetGroups<T>(assets: T[], maxBytes: number): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  let currentBytes = 2 // "[]"
  for (const a of assets) {
    const entryBytes = Buffer.byteLength(JSON.stringify(a), 'utf-8') + 1 // +1 ≈ comma
    if (current.length > 0 && currentBytes + entryBytes > maxBytes) {
      groups.push(current)
      current = []
      currentBytes = 2
    }
    current.push(a)
    currentBytes += entryBytes
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * POST with retry + backoff. Chunked upload exists to survive a flaky uplink,
 * so we always retry on network errors (fetch throws — e.g. `write EPIPE` when
 * the edge resets a stalled upload). Transient server statuses (408/429/5xx)
 * are only retried when `retryServerErrors` is set; client 4xx are always
 * returned as-is (caller surfaces the message). `makeInit` is called per
 * attempt so the request body is rebuilt fresh each time.
 *
 * The group-staging endpoint is an idempotent PUT, so retrying its 5xx is safe.
 * The commit endpoint runs a real (non-idempotent) deploy, so it passes
 * `retryServerErrors: false` — a 5xx means the server already received and
 * possibly acted on the request, and re-sending could double-deploy. Only a
 * thrown fetch (connection reset before/without a response) is retried there.
 */
export async function postWithRetry(
  url: string,
  makeInit: () => RequestInit,
  {
    attempts = 4,
    retryServerErrors = true,
  }: { attempts?: number; retryServerErrors?: boolean } = {},
): Promise<Response> {
  let lastRes: Response | undefined
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, makeInit())
      const isTransient =
        retryServerErrors && (res.status >= 500 || res.status === 408 || res.status === 429)
      if (!isTransient) {
        return res
      }
      lastRes = res
    } catch (err) {
      lastErr = err
    }
    if (attempt < attempts) {
      await new Promise((r) => setTimeout(r, Math.min(8_000, 500 * 2 ** (attempt - 1))))
    }
  }
  if (lastRes) return lastRes
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Best-effort cleanup of an upload's staged groups after a deploy gives up.
 * Fire-and-forget: a failed deploy must surface its real error, not a cleanup
 * error, so this never throws. It's not the only safety net either — the
 * deploy worker's R2 staging prefix carries a lifecycle rule that reaps
 * anything this misses (e.g. the CLI process is killed before it can abort).
 */
async function abortStagedUpload(
  appId: string,
  uploadId: string,
  totalGroups: number,
  token: string,
): Promise<void> {
  try {
    await fetch(
      `${DEPLOY_URL}/api/deploy/${appId}/assets` +
        `?uploadId=${uploadId}&totalGroups=${totalGroups}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    )
  } catch {
    // best-effort — orphaned groups are reaped by the staging lifecycle rule
  }
}

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
    adopt: {
      type: 'boolean',
      description:
        'Confirm adopting an existing app you can deploy but do not own (collaborator/admin ' +
        'on-behalf) when wrangler.toml has no DEEPSPACE_APP_ID. Without this flag an ' +
        'interactive prompt asks.',
      default: false,
    },
  },
  async run({ args }) {
    preflightNodeVersion('deploy')
    const appDir = resolve(args.dir ?? '.')
    const envName = typeof args.env === 'string' && args.env.trim() ? args.env.trim() : undefined

    // ── Read app name from wrangler.toml ──────────────────────
    if (!hasWranglerConfig(appDir)) {
      console.error('No wrangler.toml found. Are you in a DeepSpace app directory?')
      process.exit(1)
    }

    ensureInstallReady(appDir)

    p.intro('Deploying DeepSpace app')

    const wranglerConfig: WranglerConfig = readWranglerConfig(appDir)
    const nameRes = resolveAppNameForEnv(wranglerConfig, envName)
    if (!nameRes.ok) {
      p.cancel(nameRes.reason)
      process.exit(1)
    }
    // Refuse noncanonical names the same way `deepspace dev` does. Without
    // this, deploy would canonicalize server bindings while client constants
    // (`SCOPE_ID = app:${APP_NAME}`) and `[vars].APP_NAME` continued to use
    // the raw name — splitting identity across surfaces. Fail-fast so the
    // dev fixes wrangler.toml once and every surface reads from the same
    // source of truth.
    const declaredName = envName ? wranglerConfig.env?.[envName]?.name : wranglerConfig.name
    if (declaredName !== nameRes.name) {
      const where = envName ? `[env.${envName}].name` : '`name`'
      p.cancel(
        `wrangler.toml: ${where} "${declaredName}" is not in canonical form. ` +
          `Update it to "${nameRes.name}" and re-run.`,
      )
      process.exit(1)
    }
    const appName = nameRes.name

    // ── App identity ───────────────────────────────────────────
    // The immutable id is the deploy target; `name` is just the subdomain
    // label this deploy claims. A repo with no id yet gets one minted here
    // (first deploy registers it) — commit the wrangler.toml change.
    let appId = readAppId(appDir, envName)
    p.log.info(envName ? `App: ${appName}  (env: ${envName})` : `App: ${appName}`)

    // ── Ensure valid JWT ───────────────────────────────────────
    let token: string
    let ownerId: string
    try {
      token = await ensureToken()
      ownerId = decodeJwtPayload<{ sub: string }>(token).sub
    } catch (err: unknown) {
      p.cancel(errMessage(err))
      process.exit(1)
    }

    // A repo with no id yet ADOPTS the app already registered at this
    // subdomain (e.g. a legacy app the platform registered during the
    // app-identity cutover) instead of minting a fresh id that would collide
    // with the existing route registration ("name … is taken by another
    // app"). Adoption covers on-behalf deployers too — a collaborator or
    // admin deploying a legacy repo they don't own. Mints only when nothing
    // is registered here; fails up front when the name belongs to an app the
    // caller can't deploy. Needs the token, so it runs after auth.
    if (!appId) {
      const existing = await resolveExistingAppId(DEPLOY_URL, token, appName)
      if (existing.kind === 'taken') {
        p.cancel(
          `"${appName}" is taken by an app you don't have deploy access to. ` +
            'Ask the owner to add you as a collaborator (`deepspace collaborators add`), ' +
            'or pick a different `name` in wrangler.toml.',
        )
        process.exit(1)
      }
      // Adopting an app the caller does NOT own must be explicit: for an
      // admin-tier account the access check passes for EVERY registered app,
      // so a fresh project whose name collides with someone's legacy app
      // would otherwise silently deploy over it on-behalf.
      if (existing.kind === 'adopted' && !existing.owned && !args.adopt) {
        if (!process.stdin.isTTY) {
          // Piped/CI stdin: clack's confirm never resolves — fail loudly
          // with the flag remedy instead (same idiom as --rename).
          p.cancel(
            `"${appName}" is an existing app owned by another account that you can deploy ` +
              'on-behalf (collaborator/admin). Confirmation needs an interactive terminal — ' +
              're-run with --adopt to deploy it, or pick a different `name` in wrangler.toml ' +
              'if you meant a new app.',
          )
          process.exit(1)
        }
        const yes = await p.confirm({
          message:
            `"${appName}" is an existing app owned by another account that you can deploy ` +
            'on-behalf (you are a collaborator or admin). Deploy it? ' +
            '(Meant a new app? Pick a different `name` in wrangler.toml.)',
        })
        if (p.isCancel(yes) || !yes) {
          p.cancel('Deploy cancelled.')
          process.exit(1)
        }
      }
      appId = existing.kind === 'adopted' ? existing.appId : mintAppId()
      writeAppId(appDir, appId, { wranglerEnv: envName })
      p.log.info(
        existing.kind === 'adopted'
          ? `Adopted existing app id ${appId} for ${appName} — commit wrangler.toml.`
          : `Minted app id ${appId} — commit wrangler.toml.`,
      )
    }
    p.log.info(`Id: ${appId}`)

    // ── App secrets ────────────────────────────────────────────
    // Every app has one store (/api/secrets/:appId); the config shipped is
    // the wrangler env name, or 'prd' for the top-level config. No store or
    // config yet → deploy proceeds with no user secrets.
    // Reads only the hand-edited "custom" section of a .dev.vars file. We strip
    // the generated store cache first (extractCustomDevVars only drops SDK-managed
    // keys, not the GENERATED_SECRETS_DIVIDER block), mirroring writeDevVars — else
    // a stale cache entry (a just-deleted secret, or another config's secrets in
    // the shared .dev.vars) would masquerade as a hand-edited local-only var.
    const readCustomDevVarsAt = (path: string): Record<string, string> => {
      if (!existsSync(path)) return {}
      const section = extractCustomDevVars(stripGeneratedSecretsCache(readFileSync(path, 'utf-8')))
      if (!section) return {}
      try {
        return parseDevVars(section)
      } catch (err: unknown) {
        p.cancel(`.dev.vars: ${errMessage(err)}`)
        process.exit(1)
      }
    }

    let linkedSecrets: PulledSecretsCache | null = null
    // Hand-edited .dev.vars vars, snapshotted BEFORE the store refresh regenerates
    // the file — the refresh's writeDevVars overwrites the custom section with the
    // store's rendered cache, so reading afterwards would always come back empty.
    let localOnlyDevVars: Record<string, string> = {}
    try {
      const refreshed = await refreshSecretsCache(DEPLOY_URL, token, appId, envName)
      if (refreshed) {
        linkedSecrets = refreshed.pulled
        localOnlyDevVars = readCustomDevVarsAt(
          devVarsPathFor(appDir, envName, { sharedDevVarsCache: true }),
        )
        await writeDevVars(appDir, ownerId, token, envName, {
          appId,
          generatedSecretsCache: refreshed.rendered,
          sharedDevVarsCache: true,
        })
        p.log.info(refreshed.summary)
      }
    } catch (err: unknown) {
      // A 403 here means the caller isn't the owner/collaborator/admin — the
      // same gate deploy enforces. The secrets refresh just hits it first, so
      // present a clean authorization message (e.g. a revoked collaborator).
      const msg = errMessage(err)
      if ((err as { status?: number })?.status === 403) {
        p.cancel(
          "You're not authorized to deploy this app — you must be its owner or a current " +
            'collaborator. If you were a collaborator, your access may have been revoked.',
        )
      } else {
        p.cancel(`Failed to refresh app secrets before deploy: ${msg}`)
      }
      process.exit(1)
    }

    // ── Build with Vite (Cloudflare plugin bundles client + worker) ──
    // When --env is set, pass Vite a generated config with that env already
    // flattened. This keeps Cloudflare from preferring stale `.dev.vars.<env>`
    // files over DeepSpace's shared `.dev.vars` cache.
    const junk = removeMacosJunk(appDir)
    if (junk > 0) p.log.info(`Removed ${junk} macOS metadata file(s) (._*, .DS_Store)`)

    const s = createSpinner()
    s.start('Building...')
    let preparedWranglerConfig: PreparedWranglerEnvConfig | undefined
    try {
      preparedWranglerConfig = prepareWranglerEnvConfig(appDir, envName, {
        sharedDevVarsCache: linkedSecrets !== null,
      })
      execSync('npx vite build', {
        cwd: appDir,
        stdio: 'pipe',
        env: wranglerViteEnv(process.env, preparedWranglerConfig),
      })
    } catch (err: unknown) {
      s.stop('Build failed')
      // Show both streams. Vite writes build errors to stderr, but the Rules of
      // Hooks checker (vite-plugin-checker) prints its diagnostics to stdout —
      // showing only stderr would collapse a hooks violation into a bare
      // "Command failed" and hide the exact fix the developer needs.
      const execErr = err as { stdout?: { toString(): string }; stderr?: { toString(): string } }
      const detail = [execErr.stdout?.toString(), execErr.stderr?.toString()]
        .filter(Boolean)
        .join('\n')
        .trim()
      console.error(detail || errMessage(err))
      process.exit(1)
    } finally {
      preparedWranglerConfig?.cleanup()
    }
    s.stop('Built')

    // ── Locate build output via .wrangler/deploy/config.json ──
    // This is the same contract that `wrangler deploy` uses after `vite build`.
    const deployConfigPath = join(appDir, '.wrangler', 'deploy', 'config.json')
    if (!existsSync(deployConfigPath)) {
      p.cancel('Build output config not found at .wrangler/deploy/config.json')
      process.exit(1)
    }

    const deployConfig = JSON.parse(readFileSync(deployConfigPath, 'utf-8')) as {
      configPath: string
    }
    const outputWranglerPath = resolve(dirname(deployConfigPath), deployConfig.configPath)

    if (!existsSync(outputWranglerPath)) {
      p.cancel(`Output wrangler.json not found at ${outputWranglerPath}`)
      process.exit(1)
    }

    const outputConfig = JSON.parse(readFileSync(outputWranglerPath, 'utf-8')) as {
      name?: string
      main: string
      assets?: { directory: string }
      durable_objects?: { bindings: Array<{ name: string; class_name: string }> }
      migrations?: Array<{ new_sqlite_classes?: string[] }>
    }

    // Defense in depth: the deploy CLI sends `appName` as the registry
    // slot and Cloudflare Vite plugin bakes a `name` field into the
    // built wrangler.json. They MUST agree — if the generated env config
    // ever fails to apply, we'd otherwise ship one configuration's worker
    // bundle under another configuration's name.
    // Fail loudly before the upload starts.
    if (outputConfig.name && outputConfig.name !== appName) {
      const envHint = envName ? ` (--env ${envName})` : ''
      p.cancel(
        `Build output mismatch: expected name "${appName}"${envHint}, ` +
          `but the built wrangler.json declares "${outputConfig.name}". ` +
          `This usually means the Cloudflare Vite plugin didn't apply ` +
          `DeepSpace's generated env config. Check the plugin version and re-run.`,
      )
      process.exit(1)
    }

    const workerDir = dirname(outputWranglerPath)
    const workerBundlePath = join(workerDir, outputConfig.main)
    const clientDir = outputConfig.assets?.directory
      ? resolve(workerDir, outputConfig.assets.directory)
      : null

    if (!existsSync(workerBundlePath)) {
      p.cancel(`Worker bundle not found at ${workerBundlePath}`)
      process.exit(1)
    }
    if (!clientDir || !existsSync(clientDir)) {
      p.cancel(`Client assets not found at ${clientDir}`)
      process.exit(1)
    }

    // ── Collect assets ────────────────────────────────────────
    s.start('Collecting assets...')
    const assets = collectAssets(clientDir)
    s.stop(`Collected ${assets.length} assets`)

    const workerJs = readFileSync(workerBundlePath, 'utf-8')

    // ── Extract DO manifest from build output config ───────────
    const doBindings = outputConfig.durable_objects?.bindings as
      | Array<{ name: string; class_name: string }>
      | undefined
    const sqliteClasses = new Set(
      (outputConfig.migrations as Array<{ new_sqlite_classes?: string[] }> | undefined)?.flatMap(
        (m) => m.new_sqlite_classes ?? [],
      ) ?? [],
    )
    const doManifest = doBindings?.map((b) => ({
      binding: b.name,
      className: b.class_name,
      sqlite: sqliteClasses.has(b.class_name),
    }))
    if (doManifest?.length) {
      p.log.info(`DO manifest: ${doManifest.length} binding(s)`)
    }

    // ── Extract custom (non-DO) bindings: Vectorize, AI, R2, KV, D1, etc.
    const customBindings = bindingManifestFromOutputConfig(outputConfig)
    const validation = validateBindingManifest(customBindings)
    if (!validation.valid) {
      p.cancel(
        `Invalid binding(s) in wrangler.toml:\n` +
          validation.errors.map((e) => `  • ${e.reason}`).join('\n'),
      )
      process.exit(1)
    }
    if (customBindings.length) {
      p.log.info(
        `Custom bindings: ${customBindings.map((b) => `${b.name} (${b.type})`).join(', ')}`,
      )
    }

    // ── App secrets ─────────────────────────────────────────────────────
    const devVarsPath = devVarsPathFor(appDir, envName, {
      sharedDevVarsCache: linkedSecrets !== null,
    })
    // The remote secrets STORE is the single source of truth for what a deployed
    // app's env contains (docs/proposals/secrets-source-of-truth.md). `.dev.vars`
    // is a generated local dev cache — it is NEVER read to decide what ships.
    // Whether or not a store exists, deploy ships exactly the store's values; the
    // only thing we do with `.dev.vars` here is WARN when it holds secrets that
    // aren't in the store (so an edit-and-deploy doesn't silently do nothing).
    const userSecrets: Record<string, string> = linkedSecrets ? { ...linkedSecrets.values } : {}
    // Hand-edited `.dev.vars` secrets, for the warning only. When a store exists,
    // the refresh above already regenerated `.dev.vars` (wiping its custom
    // section), so use the snapshot taken before that write; with no store the
    // file was never regenerated this run, so read it fresh.
    const handEditedDevVars = linkedSecrets ? localOnlyDevVars : readCustomDevVarsAt(devVarsPath)
    const secretsDecision = classifyDevVarsSecrets({
      storeSecretNames: Object.keys(userSecrets),
      handEditedDevVarKeys: Object.keys(handEditedDevVars),
      allowMissing: Boolean(args['allow-missing-secrets']),
    })
    if (secretsDecision.kind === 'block') {
      // Store ships nothing but `.dev.vars` has hand-edited secrets: deploying
      // now would drop any secrets a previous deploy set. Stop, don't just warn.
      // `-e <env>` (not `-c`) so the upload targets the SAME env-specific app id
      // and config this deploy uses — `readAppId(appDir, envName)`. `-c` alone
      // would resolve the top-level app and upload to the wrong store.
      const uploadCmd = envName
        ? `deepspace secrets upload .dev.vars -e ${envName}`
        : 'deepspace secrets upload .dev.vars'
      const keys = secretsDecision.strayKeys.join(', ')
      p.cancel(
        `Refusing to deploy: the app store has no secrets, but .dev.vars has ${keys}.\n` +
          'Deploying now would ship the app with no secrets — replacing any a previous ' +
          'deploy set (they would be dropped from production).\n' +
          `Upload them to the store first:\n  ${uploadCmd}\n` +
          'then redeploy. (Pass --allow-missing-secrets to deploy without them.)',
      )
      process.exit(1)
    }
    if (secretsDecision.kind === 'warn') {
      const stray = secretsDecision.strayKeys
      p.log.warn(
        `.dev.vars has ${stray.join(', ')} not in the app store — ${stray.length === 1 ? 'it is' : 'they are'} NOT deployed. ` +
          '`.dev.vars` is a local dev cache, not deploy config. Move ' +
          `${stray.length === 1 ? 'it' : 'them'} into the store with ` +
          '`deepspace secrets set KEY=value` (or `deepspace secrets upload .dev.vars`), then redeploy.',
      )
    }
    const userSecretNames = Object.keys(userSecrets)

    // Pre-flight: fail clearly rather than letting the deploy-worker reject
    // mid-deploy. Reserved names are platform-owned (ASSETS, USAGE_EVENTS, …) —
    // `deepspace secrets` rejects them at write time, so this only trips on a
    // legacy store — and a secret colliding with a declared binding would
    // otherwise produce duplicate-name metadata that CF rejects opaquely.
    const declaredBindingNames = new Set([
      ...customBindings.map((b) => b.name),
      ...(doManifest ?? []).map((d) => d.binding),
    ])
    for (const name of userSecretNames) {
      if (RESERVED_BINDING_NAMES.has(name)) {
        p.cancel(
          `App secret "${name}" is a reserved binding name — remove it with \`deepspace secrets delete ${name}\`.`,
        )
        process.exit(1)
      }
      if (declaredBindingNames.has(name)) {
        p.cancel(
          `App secret "${name}" collides with a binding declared in wrangler.toml — rename one or the other.`,
        )
        process.exit(1)
      }
    }
    if (userSecretNames.length) {
      p.log.info(`App secrets: ${userSecretNames.join(', ')}`)
    }

    // ── Upload to deploy worker ───────────────────────────────
    s.start(`Deploying to ${appName}.app.space...`)

    // ── Forward custom worker-first asset routes ───────────────
    // CF Workers `[assets]` config supports a `run_worker_first` array
    // that wins over the SPA 404 fallback for matching paths. We always
    // reserve the SDK baseline (/api/*, /ws/*, /internal/*, /v1/*,
    // /_deepspace/*) on the platform side, but apps can declare extra
    // dynamic routes (e.g. /preview/*, /oauth/*, /.well-known/*) in
    // their wrangler.toml under `[assets] run_worker_first`. Pass those
    // through so the platform merges them into the deployed metadata.
    const extraRoutes = extractRunWorkerFirst(wranglerConfig)
    if (extraRoutes.length) {
      p.log.info(`Custom worker-first routes: ${extraRoutes.join(', ')}`)
    }

    // ── Choose transport: inline vs grouped ────────────────────
    // The assets array (base64-inlined file bytes) is the bulk of the upload.
    // Sending it all in one request stalls and gets reset mid-body on a
    // marginal uplink (`write EPIPE`). When it doesn't fit in a single group we
    // pack whole asset entries into groups under GROUP_BYTES, POST each group
    // on its own (retry-able) into the deploy worker's R2 staging, and
    // reference them by `uploadId` in the small commit request below. Small
    // deploys keep the original single-request inline transport.
    const assetGroups = packAssetGroups(assets, GROUP_BYTES)
    let inlineAssets: string | null = null
    let uploadId: string | null = null
    let totalGroups = 0
    if (assetGroups.length <= 1) {
      inlineAssets = JSON.stringify(assets)
    } else {
      uploadId = randomUUID()
      totalGroups = assetGroups.length
      try {
        for (let i = 0; i < totalGroups; i++) {
          const groupJson = JSON.stringify(assetGroups[i])
          s.message(`Uploading assets — group ${i + 1}/${totalGroups}...`)
          const groupRes = await postWithRetry(
            `${DEPLOY_URL}/api/deploy/${appId}/assets` +
              `?uploadId=${uploadId}&groupIndex=${i}&totalGroups=${totalGroups}`,
            () => ({
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: groupJson,
            }),
          )
          if (!groupRes.ok) {
            const errBody = (await groupRes.json().catch(() => ({}))) as { error?: string }
            // Reap the groups already staged for this upload before bailing —
            // a fresh deploy mints a new uploadId, so these would otherwise
            // never be reused.
            await abortStagedUpload(appId, uploadId, totalGroups, token)
            s.stop('Deploy failed')
            p.cancel(
              `Asset upload failed on group ${i + 1}/${totalGroups}: ` +
                `${errBody.error ?? `HTTP ${groupRes.status}`}`,
            )
            process.exit(1)
          }
        }
      } catch (err: unknown) {
        // postWithRetry exhausted its network-error retries and threw.
        await abortStagedUpload(appId, uploadId, totalGroups, token)
        s.stop('Deploy failed')
        p.cancel(`Asset upload failed (network): ${errMessage(err)}`)
        process.exit(1)
      }
      s.message(`Deploying to ${appName}.app.space...`)
    }

    const commitUrl = `${DEPLOY_URL}/api/deploy/${appId}`
    // Declared BEFORE makeForm — the closure reads it (TDZ trap otherwise).
    let confirmRename = args.rename === true

    // Every bail path must reap the staged groups (a re-run mints a new
    // uploadId, so the worker never reuses them) — one place owns that.
    const bailDeploy = async (message: string, stopLabel: string | null = 'Deploy failed'): Promise<never> => {
      if (uploadId) await abortStagedUpload(appId, uploadId, totalGroups, token)
      if (stopLabel !== null) s.stop(stopLabel)
      p.cancel(message)
      process.exit(1)
    }

    // Rebuilt per attempt so retried requests get a fresh body.
    const makeForm = (): FormData => {
      const form = new FormData()
      form.append('worker', new Blob([workerJs], { type: 'application/javascript' }), 'worker.js')
      if (inlineAssets !== null) {
        form.append('assets', inlineAssets)
      } else {
        form.append('uploadId', uploadId as string)
        form.append('totalGroups', String(totalGroups))
      }
      if (doManifest) {
        form.append('doManifest', JSON.stringify(doManifest))
      }
      if (customBindings.length) {
        form.append('bindingManifest', JSON.stringify(customBindings))
      }
      if (userSecretNames.length) {
        form.append('userSecrets', JSON.stringify(userSecrets))
      }
      // This CLI always ships the store's exact secret set (the refresh above
      // exits on failure), so tell the worker to delete live secrets we didn't
      // ship. Legacy CLIs never send this, keeping their deploys non-destructive.
      form.append('secretsAuthoritative', 'true')
      if (extraRoutes.length) {
        form.append('extraRunWorkerFirst', JSON.stringify(extraRoutes))
      }
      form.append('name', appName)
      if (confirmRename) form.append('confirmRename', 'true')
      return form
    }

    const postCommit = async (): Promise<Response> =>
      postWithRetry(
        commitUrl,
        () => ({
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: makeForm(),
        }),
        // Commit runs a real deploy — don't retry its 5xx (could double-deploy);
        // only a thrown fetch (dropped connection) is retried, and the staged
        // groups survive on the worker until this request succeeds.
        { retryServerErrors: false },
      )

    let res: Response
    try {
      res = await postCommit()
    } catch (err: unknown) {
      // The commit never got a response after its retries (dropped connection).
      await bailDeploy(`Deploy request failed: ${errMessage(err)}`)
      throw err // unreachable — bailDeploy exits
    }

    let body = (await res.json().catch(() => ({}))) as {
      success?: boolean
      url?: string
      error?: string
      code?: string
      fromHost?: string
      toHost?: string
      onBehalfOfOwner?: string
    }

    // A changed wrangler `name` is a RENAME of this app — never a silent
    // second app. Confirm interactively (or via --rename) and retry once.
    if (res.status === 409 && body.code === 'rename_required' && !confirmRename) {
      s.stop('Rename confirmation needed')
      // Piped/CI stdin: clack's confirm never resolves — the process would
      // drain its event loop and exit 0 having deployed nothing. Fail loudly
      // with the flag remedy instead.
      if (!process.stdin.isTTY) {
        await bailDeploy(
          `This deploy renames the app: ${body.fromHost} → ${body.toHost}. ` +
            'Confirmation needs an interactive terminal — re-run with --rename to approve the ' +
            'rename, or `deepspace init --new-id` if you meant a separate app.',
          null,
        )
      }
      const yes = await p.confirm({
        message:
          `This deploy renames the app: ${body.fromHost} → ${body.toHost}. ` +
          `The URL changes and the old one stops serving right away; data, secrets, and collaborators travel with it. ` +
          '(Meant a separate app? Run `deepspace init --new-id` instead.) Rename?',
      })
      if (p.isCancel(yes) || !yes) {
        await bailDeploy('Deploy cancelled.', null)
      }
      confirmRename = true
      s.start(`Deploying to ${appName}.app.space...`)
      res = await postCommit()
      body = (await res.json().catch(() => ({}))) as typeof body
    }

    if (!res.ok || !body.success) {
      await bailDeploy(formatDeployWorkerError(res.status, body.error))
    }

    // Deployed on behalf of another user: you're an admin or a collaborator on
    // their app. Say whose app it was; ownership is unchanged.
    if (body.onBehalfOfOwner) {
      p.log.warn(`Deployed on behalf of owner ${body.onBehalfOfOwner}`)
    }

    // ── Wait for assets propagation ───────────────────────────
    // Cloudflare's deploy API returns "success" once the script + bindings are
    // accepted, but the assets binding can still be indexing for ~10–60s.
    // During that window any request hits CF's transitional "Assets have not
    // yet deployed" page (HTML), even on `/api/*` routes that should run the
    // worker first. Block here until we see the worker actually serving so
    // CI / smoke checks that fire immediately don't hit the flake.
    if (body.url) {
      s.message('Waiting for edge propagation...')
      const ok = await waitForAssetsReady(body.url, 90_000)
      if (!ok) {
        s.stop('Deployed (edge propagation still in progress after 90s)')
        p.log.warn(
          'First requests may briefly hit the assets transitional page; retry in a minute.',
        )
        p.log.success(`Live at: ${body.url}`)
        await syncSubscriptionPlans(appDir, appId, token)
        await syncOneTimeProducts(appDir, appId, token)
        p.outro('Done')
        return
      }
    }

    s.stop('Deployed!')
    p.log.success(`Live at: ${body.url}`)

    // ── Reconcile subscription plans + one-time products (optional files) ──
    // Each surfaces its own result inline but never fails the deploy — a
    // developer who hasn't finished Stripe Connect onboarding still gets a
    // working deploy; they just see a warning telling them to connect first.
    await syncSubscriptionPlans(appDir, appId, token)
    await syncOneTimeProducts(appDir, appId, token)

    p.outro('Done')
  },
})

/**
 * Bundle the app's `src/subscriptions.ts` with esbuild, dynamic-import the
 * resulting ESM, and POST the declarations to /api/subscriptions/sync.
 * No-op when the file is absent.
 */
async function syncSubscriptionPlans(
  appDir: string,
  appName: string,
  token: string,
): Promise<void> {
  const subsPath = join(appDir, 'src', 'subscriptions.ts')
  if (!existsSync(subsPath)) return

  let plans: unknown
  try {
    const esbuild = await import('esbuild')
    const outDir = join(appDir, '.wrangler', 'deploy')
    const outFile = join(outDir, 'subscriptions.bundle.mjs')
    await esbuild.build({
      entryPoints: [subsPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile: outFile,
      logLevel: 'silent',
      write: true,
    })
    // Cache-bust the import so repeat deploys in the same Node process don't
    // reuse a stale module from the loader cache.
    const mod = (await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)) as {
      subscriptionPlans?: unknown
    }
    plans = mod.subscriptionPlans
  } catch (err: unknown) {
    p.log.warn(`Could not load src/subscriptions.ts: ${errMessage(err)}`)
    return
  }

  if (!Array.isArray(plans)) {
    p.log.warn('src/subscriptions.ts must `export const subscriptionPlans = [...] as const`')
    return
  }

  // The platform rejects an empty plan set (no_plans_declared), and an app with
  // no subscriptions has nothing to sync, so skip the request and stay quiet.
  // The moment a plan is declared the normal sync line and Connect warning
  // resume. Plans are removed by dropping them from a still-non-empty list; you
  // cannot reconcile down to zero plans.
  if (plans.length === 0) return

  const s = createSpinner()
  s.start('Syncing subscription plans...')

  // The deploy has already succeeded by the time we get here, so a network blip
  // or malformed response on /sync must not throw; anything unexpected becomes a
  // warning rather than a stack trace after the app is already live.
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/subscriptions/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appId: appName, plans }),
    })
  } catch (err: unknown) {
    s.stop('Plan sync skipped')
    p.log.warn(`Plan sync request failed (network): ${errMessage(err)}`)
    return
  }
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    error?: string
    hint?: string
    onboardingUrl?: string
    planChanges?: PlanChange[]
    connectMissing?: boolean
  }

  if (res.ok && body.ok) {
    s.stop(`Synced ${plans.length} plan${plans.length === 1 ? '' : 's'} to Stripe`)
    // Connect-not-yet-set-up is no longer a sync-blocking error. Plans land
    // in Stripe normally; the warning tells the developer their earnings
    // will queue in the platform balance until they finish Stripe Connect
    // onboarding. Once they connect, the first payout sweeps everything.
    if (body.connectMissing) {
      p.log.warn(
        'Stripe Connect not yet set up. Customers can subscribe and earnings ' +
          'will queue in your platform balance until you finish onboarding at ' +
          '/earnings on the dashboard. The first payout after you connect ' +
          'will sweep everything that accumulated in the meantime.',
      )
    }
    // Any plan change that stranded existing subscribers — whether the plan
    // was removed entirely or just had its price swapped — flows through one
    // prompt. The platform has no way to know whether the developer wants
    // those subscribers cancelled or grandfathered; this is the moment they
    // get to decide. Skipping is fine (silent grandfathering is the safe
    // default); they can always cancel later via the SDK helper.
    const changes = (body.planChanges ?? []).filter((c) => c.affectedSubscribers > 0)
    if (changes.length > 0) {
      await promptAndCancelChangedPlans(appName, token, changes)
    }
    return
  }

  s?.stop('Plan sync skipped')
  p.log.warn(
    `Plan sync failed: ${body.error ?? `HTTP ${res.status}`}${body.hint ? ` — ${body.hint}` : ''}`,
  )
}

// Plan-change events the deploy CLI surfaces to the developer. Mirrors the
// /sync response shape on the platform side; kept inline here so the helper
// is self-contained.
interface PlanChange {
  slug: string
  reason: 'removed' | 'repriced'
  affectedSubscribers: number
  intervals?: Array<{ interval: 'month' | 'year'; oldCents: number; newCents: number }>
}

function formatCents(c: number): string {
  return c === 0 ? 'free' : `$${(c / 100).toFixed(2)}`
}

function summaryLine(c: PlanChange): string {
  const n = c.affectedSubscribers
  const suffix = `${n} subscriber${n === 1 ? '' : 's'}`
  if (c.reason === 'removed') {
    return `  • ${c.slug} — removed (${suffix} still on it)`
  }
  // repriced: include the interval diffs for context.
  const diffs = (c.intervals ?? [])
    .map((i) => `${i.interval}: ${formatCents(i.oldCents)} → ${formatCents(i.newCents)}`)
    .join('; ')
  return `  • ${c.slug} — repriced (${diffs}; ${suffix} grandfathered on old price)`
}

/**
 * After /sync reports plans that stranded existing subscribers (removed
 * outright OR repriced with grandfathered customers), ask the developer
 * whether to cancel those subscriptions at the end of their current billing
 * period. Skipping is fine — they can run their own cleanup later via the
 * SDK's `cancelSubscription` helper.
 *
 * One yes/no prompt covers every affected plan. Granular per-plan control
 * is intentionally not surfaced; if a developer wants to cancel for plan A
 * but keep plan B, they can re-declare A in their next deploy.
 *
 * Errors here are warnings, never deploy failures: the deploy itself
 * succeeded; cleanup is the polite-but-optional tail.
 */
async function promptAndCancelChangedPlans(
  appName: string,
  token: string,
  changes: PlanChange[],
): Promise<void> {
  const summary = changes.map(summaryLine).join('\n')
  p.log.warn(
    `Plan change${changes.length === 1 ? '' : 's'} from this deploy left subscribers stranded:\n${summary}\n\n` +
      'Stripe will keep charging them until you cancel. Cancel at the end of their\n' +
      'current billing period? (Skip to leave them grandfathered.)',
  )
  const choice = await p.confirm({
    message: `Cancel ${changes.length === 1 ? 'these subscribers' : 'all of them'} at period end?`,
    initialValue: false,
  })
  if (p.isCancel(choice) || !choice) {
    p.log.info('Skipped — existing subscribers stay on their current plan/price.')
    return
  }

  // The admin-cancel endpoint batches at 50 and returns `hasMore` when there
  // are more rows to process. Loop until done so a plan with hundreds of
  // stranded subscribers gets fully cleaned up — without this, the deploy
  // prompt's confirmation ("cancel these subscribers") would silently leave
  // the tail being charged. The cap on iterations is a safety net for the
  // unlikely "nothing makes progress" path; a fresh deploy can resume.
  const MAX_ITERATIONS = 100 // 50/batch × 100 = 5000 subs/plan max per deploy
  for (const c of changes) {
    const s = createSpinner()
    s.start(
      `Canceling ${c.affectedSubscribers} subscriber${c.affectedSubscribers === 1 ? '' : 's'} on ${c.slug}...`,
    )
    let totalCanceled = 0
    let totalFailed = 0
    let iteration = 0
    let lastError: string | null = null
    let stopped = false
    try {
      while (iteration < MAX_ITERATIONS) {
        const res = await fetch(`${API_URL}/api/subscriptions/admin-cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            appName,
            planSlug: c.slug,
            atPeriodEnd: true,
            reason: `plan ${c.reason} via deploy`,
          }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          success?: boolean
          canceled?: number
          failures?: Array<{ stripeSubscriptionId: string; error: string }>
          hasMore?: boolean
          error?: string
        }
        if (!res.ok || !body.success) {
          // Genuine failure (auth, 5xx, etc.) — surface and stop. The empty-
          // match case returns 200 with hasMore=false, not an error, so this
          // branch only fires for real problems.
          lastError = body.error ?? `HTTP ${res.status}`
          s.stop(`Cancel failed for ${c.slug}: ${lastError}`)
          stopped = true
          break
        }
        const batchCanceled = body.canceled ?? 0
        totalCanceled += batchCanceled
        totalFailed += body.failures?.length ?? 0
        if (!body.hasMore) break
        // Progress guard: if a batch returned hasMore=true but canceled=0
        // (every row failed), we'd loop forever. Stop and report.
        if (batchCanceled === 0) {
          lastError = 'no progress (all rows failed this batch)'
          break
        }
        iteration++
      }
      if (!stopped) {
        const tail = totalFailed > 0 ? `; ${totalFailed} failed (see Stripe)` : ''
        const cap =
          iteration >= MAX_ITERATIONS
            ? ` (batch cap reached — re-run deploy to finish remaining)`
            : ''
        const errSuffix = lastError ? ` — ${lastError}` : ''
        s.stop(`Canceled ${totalCanceled} on ${c.slug}${tail}${cap}${errSuffix}`)
      }
    } catch (err: unknown) {
      s.stop(`Cancel failed for ${c.slug}: ${errMessage(err)}`)
    }
  }
}

/**
 * Bundle the app's `src/products.ts` with esbuild, dynamic-import the
 * resulting ESM, and POST the declarations to /api/charges/products/sync.
 * No-op when the file is absent. Mirrors syncSubscriptionPlans — products are
 * the one-time-charge equivalent of subscription plans, and the platform
 * resolves amount/name from this catalog at checkout time so the browser
 * can't pick (productId, amount) together.
 */
async function syncOneTimeProducts(appDir: string, appName: string, token: string): Promise<void> {
  const productsPath = join(appDir, 'src', 'products.ts')
  if (!existsSync(productsPath)) return

  let products: unknown
  try {
    const esbuild = await import('esbuild')
    const outDir = join(appDir, '.wrangler', 'deploy')
    const outFile = join(outDir, 'products.bundle.mjs')
    await esbuild.build({
      entryPoints: [productsPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile: outFile,
      logLevel: 'silent',
      write: true,
    })
    const mod = (await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)) as {
      oneTimeProducts?: unknown
    }
    products = mod.oneTimeProducts
  } catch (err: unknown) {
    p.log.warn(`Could not load src/products.ts: ${errMessage(err)}`)
    return
  }

  if (!Array.isArray(products)) {
    p.log.warn('src/products.ts must `export const oneTimeProducts = [...] as const`')
    return
  }

  // An empty catalog is the default for apps that don't sell one-time products.
  // Still reconcile it so emptying a previously-populated file deactivates the
  // dropped products, but skip the spinner and the "Synced 0" line so a
  // payment-free app isn't narrated on every deploy. Real failures still warn.
  const empty = products.length === 0
  const s = empty ? null : createSpinner()
  s?.start('Syncing one-time products...')

  // The deploy is already live by the time we get here, so network/parse
  // failures degrade to warnings rather than failing the deploy.
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/charges/products/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appId: appName, products }),
    })
  } catch (err: unknown) {
    s?.stop('Product sync skipped')
    p.log.warn(`Product sync request failed (network): ${errMessage(err)}`)
    return
  }
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    count?: number
    error?: string
    details?: unknown
  }

  if (res.ok && body.ok) {
    if (s) {
      const n = body.count ?? products.length
      s.stop(`Synced ${n} one-time product${n === 1 ? '' : 's'}`)
    }
    return
  }

  s?.stop('Product sync skipped')
  p.log.warn(
    `Product sync failed: ${body.error ?? `HTTP ${res.status}`}${
      body.details ? ` — ${JSON.stringify(body.details)}` : ''
    }`,
  )
}

/**
 * Poll the deployed URL until it stops returning Cloudflare's
 * "Assets have not yet deployed" transitional page. Returns true when the
 * worker is actually serving, false on timeout.
 */
async function waitForAssetsReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    try {
      const res = await fetch(url, { redirect: 'manual' })
      const body = await res.text()
      // The transitional page is HTML with the literal phrase below. Any
      // other body — worker JSON, the app's index.html, even a 404 from the
      // worker's catch-all — means the deploy is live.
      if (!body.includes('Assets have not yet deployed')) {
        return true
      }
    } catch {
      // network blip — try again
    }
    // Exponential backoff capped at 8s: 1s → 2s → 4s → 8s → 8s …
    const wait = Math.min(8_000, 1_000 * 2 ** (attempt - 1))
    await new Promise((r) => setTimeout(r, wait))
  }
  return false
}

function collectAssets(dir: string): Array<{ path: string; contentBase64: string }> {
  const assets: Array<{ path: string; contentBase64: string }> = []
  function walk(d: string, prefix: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.assetsignore') continue
      const full = join(d, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(full, rel)
      } else {
        assets.push({
          path: '/' + rel,
          contentBase64: readFileSync(full).toString('base64'),
        })
      }
    }
  }
  walk(dir, '')
  return assets
}
