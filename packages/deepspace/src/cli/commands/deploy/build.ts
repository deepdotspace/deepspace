import * as p from '@clack/prompts'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readDocumentationDeployManifest } from '../../../documentation/deploy'
import { DEEPSPACE_ENV } from '../../env'
import {
  bindingManifestFromOutputConfig,
  validateBindingManifest,
  type CustomBindingManifest,
} from '../../../server/rooms/binding-manifest'
import { readAppliedAppMigrations } from '../migrate/app-migrations'
import { removeMacosJunk } from '../../lib/macos-junk'
import { formatSchemaLintFindings, lintProjectSchemas } from '../../lib/schema-lint'
import type { Spinner } from '../../lib/spinner'
import {
  prepareWranglerEnvConfig,
  wranglerViteEnv,
  type PreparedWranglerEnvConfig,
} from '../../lib/wrangler-env'
import type { DeployOutput } from './output'

const RESERVED_RUN_WORKER_FIRST = new Set([
  '/api/*',
  '/ws/*',
  '/internal/*',
  '/v1/*',
  '/_deepspace/*',
  '/_documentation',
  '/_documentation/*',
  '/_documentation-root',
  '/_documentation-root/*',
])

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
  workerJs: string
  appMigrations: string[]
  doManifest: DurableObjectManifestEntry[] | undefined
  customBindings: CustomBindingManifest
  extraRoutes: true | string[]
}

export interface DeployAssetConfig {
  _headers?: string
  _redirects?: string
}

interface OutputWranglerConfig extends Record<string, unknown> {
  name?: string
  main: string
  assets?: { directory: string; run_worker_first?: unknown }
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> }
  migrations?: Array<{ new_sqlite_classes?: string[] }>
}

export async function buildDeployBundle(options: {
  appDir: string
  appName: string
  envName: string | undefined
  sharedDevVarsCache: boolean
  output: DeployOutput
  spinner: Spinner
}): Promise<DeployBundle> {
  const { appDir, appName, envName, sharedDevVarsCache, output, spinner } = options
  const junk = removeMacosJunk(appDir)
  if (junk > 0) p.log.info(`Removed ${junk} macOS metadata file(s) (._*, .DS_Store)`)

  const lintFindings = await lintProjectSchemas(appDir)
  if (lintFindings && lintFindings.length > 0) {
    p.log.warn(formatSchemaLintFindings(lintFindings).join('\n'))
  }

  spinner.start('Building...')
  let preparedWranglerConfig: PreparedWranglerEnvConfig | undefined
  try {
    preparedWranglerConfig = prepareWranglerEnvConfig(appDir, envName, {
      sharedDevVarsCache,
    })
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
  spinner.stop('Built')

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
  const workerJs = readFileSync(workerBundlePath, 'utf-8')

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
    workerJs,
    appMigrations,
    doManifest,
    customBindings,
    extraRoutes,
  }
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
  for (const [file, key] of [['_headers', '_headers'], ['_redirects', '_redirects']] as const) {
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
