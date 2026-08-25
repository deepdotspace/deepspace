import * as p from '@clack/prompts'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
// The retrofit text is shared with the read-only `app update` guidance, so a
// refusal here and the upgrade checklist say the same thing.
import { APP_ID_ADOPTION_STEPS } from '../../../build/app-id'
// One implementation, two lifetimes: the plugin sweeps every `vite build`,
// this deploy path guards the artifact that actually ships. See the function's
// header and docs/migrations/build-preview-secrets.md.
import { removeBuildDevVars } from '../../../build/plugin'
import { readDocumentationDeployManifest } from '../../../documentation/deploy'
import { DEEPSPACE_ENV } from '../../env'
import {
  bindingManifestFromOutputConfig,
  validateBindingManifest,
  type CustomBindingManifest,
} from '../../../server/rooms/binding-manifest'
import { readAppliedAppMigrations } from '../update/app-migrations'
import { removeMacosJunk } from '../../lib/macos-junk'
import { MAX_DEPLOY_ASSET_FILE_BYTES, formatBytes } from '../../../shared/app-files'
import { RESERVED_RUN_WORKER_FIRST as PLATFORM_RESERVED_ROUTES } from '../../../shared/app-routing'
import { formatSchemaLintFindings, lintProjectSchemas } from '../../lib/schema-lint'
import type { Spinner } from '../../lib/spinner'
import {
  prepareWranglerEnvConfig,
  wranglerViteEnv,
  type PreparedWranglerEnvConfig,
} from '../../lib/wrangler-env'
import type { DeployOutput } from './output'

/** The platform's own deny-list, imported rather than restated: two copies in
 *  two packages is how a deny-list silently stops denying. */
const RESERVED_RUN_WORKER_FIRST = new Set<string>(PLATFORM_RESERVED_ROUTES)

export interface DeployAsset {
  /** Public path the asset serves at, e.g. `/index.html`. */
  path: string
  /** Full lowercase SHA-256 hex of the file's bytes — its store address. */
  hash: string
  size: number
  /** Absolute path on disk; the upload streams from here, never from memory. */
  sourcePath: string
}

export interface DurableObjectManifestEntry {
  binding: string
  className: string
  sqlite: boolean
}

export interface DeployBundle {
  assets: DeployAsset[]
  assetConfig: DeployAssetConfig
  worker: DeployWorkerBundle
  appMigrations: string[]
  doManifest: DurableObjectManifestEntry[] | undefined
  customBindings: CustomBindingManifest
  extraRoutes: true | string[]
  /** What the app's wrangler config asked for; null when it declares none. */
  compatibilityDate: string | null
  /** Flags the app declared; the platform merges its required set on top. */
  compatibilityFlags: string[]
  /** The app's declared `[assets] not_found_handling`; null when it declares
   *  none, and the platform applies Cloudflare's default. */
  notFoundHandling: string | null
}

export interface DeployWorkerModule {
  /** POSIX path relative to the generated Worker output configuration. */
  name: string
  content: string
}

export interface DeployWorkerBundle {
  main: string
  modules: [DeployWorkerModule, ...DeployWorkerModule[]]
}

export interface DeployAssetConfig {
  _headers?: string
  _redirects?: string
}

interface OutputWranglerConfig extends Record<string, unknown> {
  name?: string
  main: string
  compatibility_date?: string
  compatibility_flags?: unknown
  assets?: { directory: string; run_worker_first?: unknown; not_found_handling?: unknown }
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> }
  migrations?: Array<{ new_sqlite_classes?: string[] }>
}

/**
 * The compatibility date the app declares, as the Cloudflare plugin resolved
 * it — which is the same value `deepspace dev` runs against locally.
 *
 * Sending it is what stops `wrangler.toml` lying: the field was read by local
 * dev and IGNORED by the deploy, so an app could develop against one runtime
 * and serve on another with nothing reporting the divergence. The platform
 * still decides what it will honor (see `resolveCompatibilityDate` in the
 * deploy worker); this only reports what the app asked for.
 */
function declaredCompatibilityDate(config: OutputWranglerConfig): string | null {
  const declared = config.compatibility_date
  return typeof declared === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(declared) ? declared : null
}

export async function buildDeployBundle(options: {
  appDir: string
  appName: string
  /** The immutable id this deploy targets — `[env.<name>.vars]
   *  DEEPSPACE_APP_ID` when `envName` is set, `[vars]` otherwise. */
  appId: string
  envName: string | undefined
  output: DeployOutput
  spinner: Spinner
}): Promise<DeployBundle> {
  const { appDir, appName, appId, envName, output, spinner } = options
  const junk = removeMacosJunk(appDir)
  if (junk > 0) p.log.info(`Removed ${junk} macOS metadata file(s) (._*, .DS_Store)`)

  const lintFindings = await lintProjectSchemas(appDir)
  if (lintFindings && lintFindings.length > 0) {
    p.log.warn(formatSchemaLintFindings(lintFindings).join('\n'))
  }

  const buildStarted = Date.now()
  spinner.start('Building...')
  let preparedWranglerConfig: PreparedWranglerEnvConfig | undefined
  try {
    preparedWranglerConfig = prepareWranglerEnvConfig(appDir, envName)
    const appDomain = DEEPSPACE_ENV === 'staging' ? 'spacestest.com' : 'app.space'
    execSync('npx vite build', {
      cwd: appDir,
      stdio: 'pipe',
      env: {
        ...wranglerViteEnv(process.env, preparedWranglerConfig),
        // The Vite plugin's one documentation compile stamps release URLs.
        DEEPSPACE_DOCUMENTATION_BASE_URL: `https://${appName}.${appDomain}/docs`,
      },
    })
  } catch (error: unknown) {
    spinner.stop('Build failed')
    const execError = error as {
      stdout?: { toString(): string }
      stderr?: { toString(): string }
    }
    const detail = [execError.stdout?.toString(), execError.stderr?.toString()]
      .filter(Boolean)
      .join('\n')
      .trim()
    output.die(detail || errorMessage(error), 'build_failed')
  } finally {
    preparedWranglerConfig?.cleanup()
  }
  spinner.stop(`Built (${Math.round((Date.now() - buildStarted) / 1000)}s)`)

  const deployConfigPath = join(appDir, '.wrangler', 'deploy', 'config.json')
  if (!existsSync(deployConfigPath)) {
    output.die(
      'Build output config not found at .wrangler/deploy/config.json',
      'build_output_missing',
    )
  }

  const deployConfig = JSON.parse(readFileSync(deployConfigPath, 'utf-8')) as {
    configPath: string
  }
  const outputWranglerPath = resolve(dirname(deployConfigPath), deployConfig.configPath)
  if (!existsSync(outputWranglerPath)) {
    output.die(`Output wrangler.json not found at ${outputWranglerPath}`, 'build_output_missing')
  }

  const outputConfig = JSON.parse(readFileSync(outputWranglerPath, 'utf-8')) as OutputWranglerConfig
  if (outputConfig.name && outputConfig.name !== appName) {
    const envHint = envName ? ` (--env ${envName})` : ''
    output.die(
      `Build output mismatch: expected name "${appName}"${envHint}, ` +
        `but the built wrangler.json declares "${outputConfig.name}". ` +
        `This usually means the Cloudflare Vite plugin didn't apply ` +
        `DeepSpace's generated env config. Check the plugin version and re-run.`,
      'build_output_mismatch',
    )
  }

  const workerDir = dirname(outputWranglerPath)
  try {
    removeBuildDevVars(workerDir)
  } catch (error) {
    output.die(errorMessage(error), 'build_output_unsafe')
  }
  const workerBundlePath = join(workerDir, outputConfig.main)
  const clientDir = outputConfig.assets?.directory
    ? resolve(workerDir, outputConfig.assets.directory)
    : null
  if (!existsSync(workerBundlePath)) {
    output.die(`Worker bundle not found at ${workerBundlePath}`, 'build_output_missing')
  }
  if (!clientDir || !existsSync(clientDir)) {
    return output.die(`Client assets not found at ${clientDir}`, 'build_output_missing')
  }

  try {
    const manifest = readDocumentationDeployManifest(appDir, clientDir)
    if (manifest) p.log.info(`Documentation: ${manifest.pageCount} page(s)`)
  } catch (error) {
    output.die(errorMessage(error), 'documentation_build_failed')
  }

  spinner.start('Collecting assets...')
  const assets = collectAssets(clientDir)
  const assetConfig = readDeployAssetConfig(clientDir)
  spinner.stop(`Collected ${assets.length} assets`)

  const appIdRefusal = clientAppIdRefusal(assets, appId, envName)
  if (appIdRefusal) output.die(appIdRefusal.message, appIdRefusal.code)

  const worker = (() => {
    try {
      return collectWorkerBundle(workerDir, workerBundlePath, clientDir)
    } catch (error) {
      return output.die(errorMessage(error), 'build_output_invalid')
    }
  })()

  const doBindings = outputConfig.durable_objects?.bindings
  const sqliteClasses = new Set(
    outputConfig.migrations?.flatMap((migration) => migration.new_sqlite_classes ?? []) ?? [],
  )
  const doManifest = doBindings?.map((binding) => ({
    binding: binding.name,
    className: binding.class_name,
    sqlite: sqliteClasses.has(binding.class_name),
  }))
  if (doManifest?.length) p.log.info(`DO manifest: ${doManifest.length} binding(s)`)

  const customBindings = bindingManifestFromOutputConfig(outputConfig)
  const validation = validateBindingManifest(customBindings)
  if (!validation.valid) {
    output.die(
      `Invalid binding(s) in wrangler.toml:\n` +
        validation.errors.map((error) => `  • ${error.reason}`).join('\n'),
      'invalid_bindings',
    )
  }
  if (customBindings.length) {
    p.log.info(
      `Custom bindings: ${customBindings.map((binding) => `${binding.name} (${binding.type})`).join(', ')}`,
    )
  }

  // The Cloudflare build output is the selected environment's resolved
  // configuration and therefore the same routing authority used by local
  // development. Do not infer routing from feature files here.
  const extraRoutes = resolveDeployRunWorkerFirst(outputConfig)
  let appMigrations: string[] = []
  try {
    appMigrations = readAppliedAppMigrations(appDir)
  } catch (error) {
    output.die(errorMessage(error), 'invalid_migration_manifest')
  }

  return {
    assets,
    assetConfig,
    worker,
    appMigrations,
    doManifest,
    customBindings,
    extraRoutes,
    compatibilityDate: declaredCompatibilityDate(outputConfig),
    compatibilityFlags: Array.isArray(outputConfig.compatibility_flags)
      ? outputConfig.compatibility_flags.filter((flag): flag is string => typeof flag === 'string')
      : [],
    notFoundHandling:
      typeof outputConfig.assets?.not_found_handling === 'string'
        ? outputConfig.assets.not_found_handling
        : null,
  }
}

const WORKER_ES_MODULE = /\.(?:js|mjs)$/i

/**
 * Collect every JavaScript module emitted beside the generated Wrangler
 * configuration. The Cloudflare Vite plugin writes `no_bundle: true` and
 * declares `**\/*.js` / `**\/*.mjs` as ES modules, so the output directory —
 * not only `config.main` — is the deployable Worker graph.
 */
export function collectWorkerBundle(
  workerDir: string,
  mainPath: string,
  clientDir?: string | null,
): DeployWorkerBundle {
  const root = resolve(workerDir)
  const mainAbsolute = resolve(mainPath)
  const excludedClient = clientDir ? resolve(clientDir) : null
  const main = moduleName(root, mainAbsolute)
  const modules: DeployWorkerModule[] = []

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const fullPath = join(directory, entry.name)
      if (excludedClient && isWithin(excludedClient, fullPath)) continue
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile() && WORKER_ES_MODULE.test(entry.name)) {
        modules.push({ name: moduleName(root, fullPath), content: readFileSync(fullPath, 'utf-8') })
      }
    }
  }
  walk(root)

  const mainIndex = modules.findIndex((module) => module.name === main)
  if (mainIndex < 0) throw new Error(`Worker main module not found in generated output: ${main}`)
  const [mainModule] = modules.splice(mainIndex, 1)
  return { main, modules: [mainModule, ...modules] }
}

function moduleName(root: string, path: string): string {
  const name = relative(root, path)
  if (!name || isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`)) {
    throw new Error(`Worker module is outside the generated output directory: ${path}`)
  }
  return name.split(sep).join('/')
}

function isWithin(root: string, path: string): boolean {
  const name = relative(root, path)
  return name === '' || (!isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`))
}

type WorkerFirstConfig = { assets?: { run_worker_first?: unknown } }

export function extractRunWorkerFirst(config: WorkerFirstConfig): string[] {
  const raw = Array.isArray(config.assets?.run_worker_first) ? config.assets.run_worker_first : []

  const routes: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const route = entry.trim()
    if (!route.startsWith('/') || RESERVED_RUN_WORKER_FIRST.has(route) || seen.has(route)) continue
    seen.add(route)
    routes.push(route)
  }
  return routes
}

export function resolveDeployRunWorkerFirst(config: WorkerFirstConfig): true | string[] {
  if (config.assets?.run_worker_first === true) return true
  const routes = extractRunWorkerFirst(config)
  return routes
}

/**
 * Name what the platform would refuse, from the local build, BEFORE anything
 * irreversible happens. The server checks this too, but only after the commit
 * has already been pushed to the cloud repo — which left the repo advanced on
 * a release that then failed. Checking here also lets the message name the
 * file, where the server's asset-plan request carries only hashes.
 *
 * ONLY the per-file cap. The per-deploy TOTAL is env-configurable
 * (`MAX_DEPLOY_TOTAL_BYTES`) and the server dedupes by content hash before
 * summing, so any local total is both a guess at the limit and a different
 * arithmetic — five copies of one 24 MiB file are 24 MiB to the platform and
 * would have been 120 MiB here. The server owns that refusal.
 */
export function oversizedAssetRefusal(assets: DeployAsset[]): string | null {
  const tooBig = assets.find((asset) => asset.size > MAX_DEPLOY_ASSET_FILE_BYTES)
  if (!tooBig) return null
  return (
    `${tooBig.path} is ${formatBytes(tooBig.size)}; the per-file limit for deploy assets is ` +
    `${formatBytes(MAX_DEPLOY_ASSET_FILE_BYTES)}. ${LARGE_MEDIA_HOME}`
  )
}

/** Scripts and markup the browser evaluates — where a baked-in app id lands.
 *  Images/fonts/sourcemaps are excluded: nothing keys a RecordRoom from them,
 *  and scanning them only invents false refusals. */
const CLIENT_CODE_ASSET = /\.(?:js|mjs|html)$/i

/** `app_` + 26 Crockford base32 chars, anywhere in a file (not anchored — the
 *  point is to find it inside minified code). Mirrors `APP_ID_RE`, which is
 *  anchored and therefore can't be reused for a scan. */
const APP_ID_LITERAL = /app_[0-9A-HJKMNP-TV-Z]{26}/g

/** The identifier the current template's client reads its id from. Vite
 *  replaces it through `define`; an occurrence in a BUILT asset means nothing
 *  did. */
const APP_ID_DEFINE = '__DEEPSPACE_APP_ID__'

export interface ClientAppIdRefusal {
  message: string
  code: string
}

/**
 * Refuse a deploy whose built client is not keyed to the app being deployed —
 * either because it carries a FOREIGN id, or because it carries NO id at all.
 *
 * NET-NEW COMPLEXITY, deliberately, and one scan for both. The root cause is
 * fixed in the scaffold (the template's client no longer holds a literal id —
 * it reads `DEEPSPACE_APP_ID` out of the wrangler config the build ran
 * against), but a template only reaches apps scaffolded after it. Every app
 * already on disk still has `export const APP_ID = 'app_…'` frozen at scaffold
 * time, so `deploy --env staging` builds a browser bundle keyed to the DEFAULT
 * env's rooms while the worker writes the staging env's — reported as
 * `ok:true, serving:confirmed`, with the two halves reading different data
 * stores. `app update` guides those apps through the
 * `2026-08-build-injected-app-id` migration; this guard is for apps that have
 * not completed it.
 *
 * The second check exists because adopting the fix is a multi-file change, and
 * applying only the `src/constants.ts` part is silent: Vite leaves an unmatched
 * `define` identifier in the output, emits no warning, and the browser throws
 * `ReferenceError: __DEEPSPACE_APP_ID__ is not defined` on the first module
 * that imports it. No `app_…` literal survives that edit either, so the
 * foreign-id scan sees a clean bundle and the deploy proceeds — a silent total
 * outage in place of a silent wrong-store deploy. One emitted identifier is a
 * cheap, exact signal that the client was moved halfway, and it belongs here
 * rather than in a second pass over the same files.
 *
 * Detection is a literal scan of the built client code. That is reliable for
 * the case that matters: an app id is an opaque 26-char constant and the
 * define is a reserved-looking identifier, so bundlers carry both through
 * minification intact — there is no folding, mangling, or splitting to do to
 * them. Limits: it cannot see an id assembled at runtime from parts, and it
 * cannot tell an id the app *uses* from one it merely *mentions* — an app that
 * deliberately names another app's id in client code is refused and must move
 * that literal server-side.
 */
export function clientAppIdRefusal(
  assets: DeployAsset[],
  appId: string,
  envName?: string,
): ClientAppIdRefusal | null {
  const foreign = new Map<string, string>()
  let unsubstituted: string | undefined
  for (const asset of assets) {
    if (!CLIENT_CODE_ASSET.test(asset.path)) continue
    const source = readFileSync(asset.sourcePath, 'utf-8')
    if (unsubstituted === undefined && source.includes(APP_ID_DEFINE)) unsubstituted = asset.path
    for (const found of source.matchAll(APP_ID_LITERAL)) {
      if (found[0] !== appId && !foreign.has(found[0])) foreign.set(found[0], asset.path)
    }
  }

  // The dead-bundle case first: it is fatal on load, where a foreign id at
  // least renders.
  if (unsubstituted !== undefined) {
    return {
      code: 'app_id_define_unsubstituted',
      message:
        `Built client assets still contain \`${APP_ID_DEFINE}\` (first in ${unsubstituted}) — ` +
        `nothing replaced it at build time. The browser evaluates that identifier and throws ` +
        `ReferenceError before the app renders, so this bundle is a blank page for every ` +
        `visitor. src/constants.ts was moved onto the build-time app id without the build ` +
        `config that supplies it.\n${APP_ID_ADOPTION_STEPS}`,
    }
  }
  if (foreign.size === 0) return null

  const target = envName ? `--env ${envName} (${appId})` : appId
  return {
    code: 'app_id_env_mismatch',
    message:
      `Built client assets carry a different app id than the one being deployed. ` +
      `Deploying ${target}, but the bundle contains:\n` +
      [...foreign].map(([id, path]) => `  • ${id} in ${path}`).join('\n') +
      `\nThe browser keys its RecordRooms to the id in the bundle, so this would ` +
      `serve ${envName ? `${envName}'s` : "this app's"} worker against another app's data. ` +
      `The usual cause is an app scaffolded before the id was build-injected: ` +
      `src/constants.ts still holds \`export const APP_ID = 'app_…'\` frozen at scaffold ` +
      `time.\n${APP_ID_ADOPTION_STEPS}`,
  }
}

const LARGE_MEDIA_HOME =
  'Large media belongs in your app files (`deepspace app files put`), not in the deploy bundle — ' +
  'move it out of `public/` and reference it at runtime.'

/**
 * Walk the built client directory and address every file by content. Hashing
 * happens here so the deploy can ask the platform which bytes it already has
 * before moving any of them.
 */
export function collectAssets(dir: string): DeployAsset[] {
  const assets: DeployAsset[] = []
  const walk = (currentDir: string, prefix: string): void => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (isDeployAssetControlFile(entry.name)) continue
      const fullPath = join(currentDir, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(fullPath, relativePath)
      } else {
        const bytes = readFileSync(fullPath)
        assets.push({
          path: `/${relativePath}`,
          hash: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.byteLength,
          sourcePath: fullPath,
        })
      }
    }
  }
  walk(dir, '')
  return assets
}

export function readDeployAssetConfig(clientDir: string): DeployAssetConfig {
  const config: DeployAssetConfig = {}
  for (const [file, key] of [
    ['_headers', '_headers'],
    ['_redirects', '_redirects'],
  ] as const) {
    const filePath = join(clientDir, file)
    if (!existsSync(filePath)) continue
    const content = readFileSync(filePath, 'utf8')
    if (content.trim()) config[key] = content
  }
  return config
}

export function isDeployAssetControlFile(name: string): boolean {
  return name === '.assetsignore' || name === '_headers' || name === '_redirects'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
