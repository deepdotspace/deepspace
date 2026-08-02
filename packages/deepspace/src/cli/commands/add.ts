/**
 * deepspace add <feature> [dir]
 *
 * Catalog reads use this running CLI's package. Installation loads the typed
 * installer shipped by the target app's installed DeepSpace version, so an
 * app never receives feature files or manifest rules from a different SDK.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureInstallReady } from '../lib/install-status'
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'
import {
  featureCatalog,
  featurePackageRoot,
  hasFeatureCatalog,
  installFeature as runningInstaller,
  listFeatureConfigs,
  readFeatureConfig,
  resolveFeatureDestPath,
  suggestFeature,
  type FeatureConfig,
  type FeatureInstallOptions,
  type FeatureInstallOutcome,
} from './feature-installer'

const CATEGORY_LABELS: Record<string, string> = {
  assistant: 'AI Features',
  data: 'Data Features',
  nav: 'Navigation',
  layout: 'Layouts',
  display: 'Display',
  landing: 'Landing Page Sections',
}
const CATEGORY_ORDER = ['assistant', 'data', 'nav', 'layout', 'display', 'landing']

interface FeatureInstallerModule {
  installFeature(options: FeatureInstallOptions): FeatureInstallOutcome
}

function groupByCategory(features: FeatureConfig[]): Map<string, FeatureConfig[]> {
  const groups = new Map<string, FeatureConfig[]>()
  for (const feature of features) {
    const category = feature.category ?? 'other'
    groups.set(category, [...(groups.get(category) ?? []), feature])
  }
  return groups
}

function orderedCategories(groups: Map<string, FeatureConfig[]>): string[] {
  const known = CATEGORY_ORDER.filter((category) => groups.has(category))
  const unknown = [...groups.keys()]
    .filter((category) => !CATEGORY_ORDER.includes(category))
    .sort((a, b) => a.localeCompare(b))
  return [...known, ...unknown]
}

function catalogLines(
  groups: Map<string, FeatureConfig[]>,
  render: (feature: FeatureConfig) => string,
): string[] {
  const lines: string[] = []
  for (const category of orderedCategories(groups)) {
    const features = groups.get(category)
    if (!features?.length) continue
    lines.push(`${CATEGORY_LABELS[category] ?? category}:`)
    for (const feature of features) lines.push(render(feature))
    lines.push('')
  }
  return lines
}

export function renderFeatureHelp(packageRoot: string = featurePackageRoot()): string {
  const groups = groupByCategory(listFeatureConfigs(packageRoot))
  const example = orderedCategories(groups)
    .map((category) => groups.get(category)?.[0]?.id)
    .find(Boolean)
  return [
    '',
    'Add a feature to your DeepSpace app',
    '',
    'Usage: deepspace add <feature> [dir]',
    '',
    'Commands:',
    '  <feature> [dir]     Install a feature (dir defaults to .)',
    '  --list, -l          List all available features',
    '  --info <feature>    Show detailed info about a feature',
    '  --install           Run your package manager after adding deps',
    '  --help, -h          Show this help',
    '',
    ...catalogLines(groups, (feature) => `  ${feature.id.padEnd(22)} ${feature.name}`),
    'Examples:',
    '  deepspace add --list',
    `  deepspace add ${example ?? '<feature>'}`,
    `  deepspace add ${example ?? '<feature>'} ./my-app`,
    '',
  ].join('\n')
}

export function renderFeatureList(packageRoot: string = featurePackageRoot()): string {
  const groups = groupByCategory(listFeatureConfigs(packageRoot))
  return [
    '',
    'Available Features',
    '',
    ...catalogLines(
      groups,
      (feature) =>
        `  ${feature.id.padEnd(22)} ${feature.name.padEnd(24)} ${feature.description ?? ''}`,
    ),
    'Use: deepspace add <feature>',
    '',
  ].join('\n')
}

export function renderFeatureInfo(config: FeatureConfig): string {
  const lines = ['', `${config.name} (${config.id})`]
  if (config.category) {
    lines.push(`   Category: ${CATEGORY_LABELS[config.category] ?? config.category}`)
  }
  lines.push(`   ${config.description ?? ''}`, '', `   ${config.details ?? ''}`, '', '   Files:')
  for (const file of config.files) {
    lines.push(`   - ${file.src} -> ${resolveFeatureDestPath(file.dest, config.route)}`)
  }
  if (config.instructions?.length) {
    lines.push('', '   Integration steps:')
    config.instructions.forEach((instruction, index) => {
      lines.push(`   ${index + 1}. ${instruction}`)
    })
  }
  if (config.patterns?.length) {
    lines.push('', '   Patterns:')
    config.patterns.forEach((pattern) => lines.push(`   - ${pattern}`))
  }
  if (config.example) {
    lines.push('', '   Example:')
    config.example.split('\n').forEach((line) => lines.push(`   ${line}`))
  }
  lines.push('')
  return lines.join('\n')
}

/** A bare directory is not an install target even if dependency setup happens to exist above it. */
export function isDeepSpaceApp(dir: string): boolean {
  if (existsSync(join(dir, 'wrangler.toml'))) return true
  const packagePath = join(dir, 'package.json')
  if (!existsSync(packagePath)) return false
  try {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return Boolean(pkg.dependencies?.deepspace || pkg.devDependencies?.deepspace)
  } catch {
    return false
  }
}

/** Match Node's upward dependency lookup, including DeepSpace worktrees nested in an app. */
function installedPackageRoot(fromDir: string): string | null {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', 'deepspace')
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function targetInstaller(appDir: string): Promise<FeatureInstallerModule> {
  const installedRoot = installedPackageRoot(appDir)
  if (!installedRoot) {
    throw new Refusal(
      "Could not resolve the app's installed deepspace package. Run your package manager, then retry.",
      'feature_installer_missing',
    )
  }

  // Tests and source checkouts commonly link this exact package. Avoid asking
  // them for an emitted build entry when the already-loaded typed owner is the
  // same package on disk.
  if (realpathSync(installedRoot) === realpathSync(featurePackageRoot())) {
    return { installFeature: runningInstaller }
  }

  const entry = join(installedRoot, 'dist', 'feature-installer.js')
  const catalog = join(installedRoot, 'features')
  if (!existsSync(entry) || !existsSync(catalog)) {
    throw new Refusal(
      "The app's installed deepspace package does not contain the typed feature installer.\n" +
        `Expected: ${entry}\n` +
        'Install a current DeepSpace version in the app, then retry.',
      'feature_installer_missing',
    )
  }

  let loaded: Partial<FeatureInstallerModule>
  try {
    loaded = (await import(pathToFileURL(entry).href)) as Partial<FeatureInstallerModule>
  } catch (error) {
    throw new Refusal(
      `Could not load the app's feature installer: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'feature_installer_invalid',
    )
  }
  if (typeof loaded.installFeature !== 'function') {
    throw new Refusal(`Invalid feature installer entry: ${entry}`, 'feature_installer_invalid')
  }
  return loaded as FeatureInstallerModule
}

function catalogRoot(): string {
  const root = featurePackageRoot()
  if (!hasFeatureCatalog(root)) {
    throw new Refusal(
      'Could not find the deepspace feature catalog.\n' +
        'Reinstall deepspace or run inside a DeepSpace app.',
      'feature_catalog_missing',
    )
  }
  return root
}

export default defineDeepspaceCommand({
  meta: {
    name: 'add',
    description: 'Add a feature to your DeepSpace app',
  },
  args: {
    list: {
      type: 'boolean',
      alias: 'l',
      description: 'List available features',
      required: false,
    },
    info: {
      type: 'string',
      description: 'Show details about a feature',
      required: false,
    },
    install: {
      type: 'boolean',
      description: 'Run your package manager after adding dependencies',
      required: false,
    },
    feature: {
      type: 'positional',
      description: 'Feature to install',
      required: false,
    },
    dir: {
      type: 'positional',
      description: 'App directory (default: current directory)',
      required: false,
    },
  },
  async run({ args }) {
    const feature = args.feature as string | undefined
    const info = args.info as string | undefined

    if (args.list || info || !feature) {
      const root = catalogRoot()
      if (info) {
        const config = readFeatureConfig(info, root)
        if (!config) {
          const suggestion = suggestFeature(info, root)
          throw new Refusal(
            [
              `Unknown feature: ${info}`,
              ...(suggestion ? [`Did you mean "${suggestion}"?`] : []),
              'Run `deepspace add --list` to see available features.',
            ].join('\n'),
            'unknown_feature',
            { action: cliAction('deepspace', 'add', '--list') },
          )
        }
        if (!args.json) process.stdout.write(renderFeatureInfo(config))
        return { data: { feature: config } }
      }

      if (!args.json) {
        process.stdout.write(args.list ? renderFeatureList(root) : renderFeatureHelp(root))
      }
      return { data: { features: featureCatalog(root) } }
    }

    const appDir = resolve((args.dir as string | undefined) ?? '.')
    if (!existsSync(appDir)) {
      throw new Refusal(
        `Target directory not found: ${appDir}\nCreate a new app first: deepspace app create <name>`,
        'app_dir_not_found',
      )
    }
    if (!isDeepSpaceApp(appDir)) {
      throw new Refusal(
        `Not a DeepSpace app: ${appDir}\n` +
          '(no wrangler.toml and no "deepspace" dependency found)\n' +
          'Create one with: deepspace app create <name>',
        'not_a_deepspace_app',
      )
    }

    ensureInstallReady(appDir)
    const installer = await targetInstaller(appDir)
    let outcome: FeatureInstallOutcome
    try {
      outcome = installer.installFeature({
        feature,
        targetDir: appDir,
        installDependencies: Boolean(args.install),
        ...(!args.json
          ? {
              emit(line: string, stream: 'stdout' | 'stderr' = 'stdout') {
                if (stream === 'stderr') console.error(line)
                else console.log(line)
              },
            }
          : {}),
      })
    } catch (error) {
      throw new Refusal(
        `Installing '${feature}' failed: ${error instanceof Error ? error.message : String(error)}`,
        'add_failed',
      )
    }
    if (!outcome || typeof outcome.ok !== 'boolean') {
      throw new Refusal(
        "The app's feature installer returned an invalid result.",
        'feature_installer_invalid',
      )
    }

    if (!outcome.ok) {
      throw new Refusal(outcome.error, outcome.code, {
        ...('data' in outcome ? { extra: outcome.data } : {}),
      })
    }
    return {
      data: outcome.data,
      ...(outcome.action ? { action: outcome.action } : {}),
    }
  },
})
