import * as p from '@clack/prompts'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
  type WranglerConfig,
} from '../../lib/wrangler-env'
import type { DeployOutput } from './output'

const RESERVED_RUN_WORKER_FIRST = new Set([
  '/api/*',
  '/ws/*',
  '/internal/*',
  '/v1/*',
  '/_deepspace/*',
])

export interface DeployAsset {
  path: string
  contentBase64: string
}

export interface DurableObjectManifestEntry {
  binding: string
  className: string
  sqlite: boolean
}

export interface DeployBundle {
  assets: DeployAsset[]
  workerJs: string
  appMigrations: string[]
  doManifest: DurableObjectManifestEntry[] | undefined
  customBindings: CustomBindingManifest
  extraRoutes: string[]
}

interface OutputWranglerConfig extends Record<string, unknown> {
  name?: string
  main: string
  assets?: { directory: string }
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> }
  migrations?: Array<{ new_sqlite_classes?: string[] }>
}

export async function buildDeployBundle(options: {
  appDir: string
  appName: string
  envName: string | undefined
  sharedDevVarsCache: boolean
  wranglerConfig: WranglerConfig
  output: DeployOutput
  spinner: Spinner
}): Promise<DeployBundle> {
  const { appDir, appName, envName, sharedDevVarsCache, wranglerConfig, output, spinner } = options
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
    execSync('npx vite build', {
      cwd: appDir,
      stdio: 'pipe',
      env: wranglerViteEnv(process.env, preparedWranglerConfig),
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

  spinner.start('Collecting assets...')
  const assets = collectAssets(clientDir)
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

  const extraRoutes = extractRunWorkerFirst(wranglerConfig)
  let appMigrations: string[] = []
  try {
    appMigrations = readAppliedAppMigrations(appDir)
  } catch (error) {
    output.die(errorMessage(error), 'invalid_migration_manifest')
  }

  return {
    assets,
    workerJs,
    appMigrations,
    doManifest,
    customBindings,
    extraRoutes,
  }
}

function extractRunWorkerFirst(config: WranglerConfig): string[] {
  const raw = config.assets?.run_worker_first
  if (!Array.isArray(raw)) return []

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

function collectAssets(dir: string): DeployAsset[] {
  const assets: DeployAsset[] = []
  const walk = (currentDir: string, prefix: string): void => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === '.assetsignore') continue
      const fullPath = join(currentDir, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(fullPath, relativePath)
      } else {
        assets.push({
          path: `/${relativePath}`,
          contentBase64: readFileSync(fullPath).toString('base64'),
        })
      }
    }
  }
  walk(dir, '')
  return assets
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
