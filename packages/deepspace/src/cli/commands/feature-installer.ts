/**
 * The feature catalog and installer.
 *
 * This is a separate build entry because `add` loads the copy shipped by the
 * target app's installed `deepspace` package. That keeps feature files,
 * manifest interpretation, and mutations on the app-pinned SDK version while
 * leaving the public command/output contract in add.ts.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectPackageManager } from '../lib/package-manager'

const NAV_MARKER = '// ── Features add nav items below this line ──'

interface FeatureFile {
  src: string
  dest: string
  overwrite?: boolean
}

interface FeatureSchema {
  exportName: string
  importPath: string
  spreadOperator?: boolean
}

interface FeatureAction {
  exportName: string
  registerAs: string
  importPath: string
}

interface FeatureCodeInsertion {
  file: string
  marker: string
  insert: string
  placement?: 'before' | 'after'
  import?: string
}

interface FeatureWranglerIntegration {
  runWorkerFirst?: boolean
  rateLimits?: Array<{
    name: string
    namespaceId: string
    limit: number
    period: 10 | 60
  }>
}

export interface FeatureConfig {
  id: string
  name: string
  category?: string
  description?: string
  details?: string
  internal?: boolean
  files: FeatureFile[]
  ignore?: string[]
  route?: { path?: string; protected?: boolean }
  schema?: FeatureSchema
  actions?: FeatureAction[]
  code?: FeatureCodeInsertion[]
  wrangler?: FeatureWranglerIntegration
  css?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  instructions?: string[]
  patterns?: string[]
  agentNotes?: string[]
  example?: string
  [key: string]: unknown
}

export interface FeatureCatalogEntry {
  id: string
  name: string
  category: string | null
  description: string | null
}

type DependencySection = 'dependencies' | 'devDependencies'

interface DependencyAddition {
  name: string
  section: DependencySection
  version: unknown
}

type IntegrationArea = 'schema' | 'actions' | 'code' | 'css' | 'nav' | 'wrangler'

interface UnresolvedIntegration {
  area: IntegrationArea
  reason: string
  steps: string[]
}

interface InstallData extends Record<string, unknown> {
  feature: string
  dir: string
  installed: boolean
  observedChanges: {
    files: { created: string[]; preexisting: string[]; missing: string[] }
    dependencies: {
      added: DependencyAddition[]
      missingDeclarations: string[]
      installRequested: boolean
      diagnosticTail?: string
    }
  }
  unresolvedIntegrations: UnresolvedIntegration[]
  manifestGuidance: {
    instructions: string[]
    patterns: string[]
    agentNotes: string[]
  }
}

interface InstallerAction {
  cwd: string
  argv: string[]
}

export type FeatureInstallOutcome =
  | { ok: true; data: InstallData; action?: InstallerAction }
  | {
      ok: false
      code: 'unknown_feature'
      error: string
      data: {
        requestedFeature: string
        suggestedFeature: string | null
        availableFeatures: FeatureCatalogEntry[]
      }
    }
  | {
      ok: false
      code: 'dependency_install_failed' | 'manual_integration_required'
      error: string
      data: InstallData
    }

export type FeatureInstallerOutput = (line: string, stream?: 'stdout' | 'stderr') => void

export interface FeatureInstallOptions {
  feature: string
  targetDir: string
  installDependencies: boolean
  emit?: FeatureInstallerOutput
}

/** Find the package containing this source file or emitted build entry. */
export function featurePackageRoot(moduleUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    const packagePath = join(dir, 'package.json')
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { name?: unknown }
        if (pkg.name === 'deepspace') return dir
      } catch {
        // Keep walking: a nearer unrelated package.json is not this package.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error('Could not locate the deepspace package root')
    dir = parent
  }
}

export function hasFeatureCatalog(packageRoot: string = featurePackageRoot()): boolean {
  return existsSync(join(packageRoot, 'features'))
}

export function readFeatureConfig(
  id: string,
  packageRoot: string = featurePackageRoot(),
): FeatureConfig | null {
  const configPath = join(packageRoot, 'features', id, 'feature.json')
  if (!existsSync(configPath)) return null
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<FeatureConfig>
    if (
      typeof config.id !== 'string' ||
      typeof config.name !== 'string' ||
      !Array.isArray(config.files)
    ) {
      return null
    }
    return config as FeatureConfig
  } catch {
    return null
  }
}

export function listFeatureConfigs(packageRoot: string = featurePackageRoot()): FeatureConfig[] {
  const featuresDir = join(packageRoot, 'features')
  if (!existsSync(featuresDir)) return []
  return readdirSync(featuresDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFeatureConfig(entry.name, packageRoot))
    .filter((config): config is FeatureConfig => config !== null && !config.internal)
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function featureCatalog(packageRoot: string = featurePackageRoot()): FeatureCatalogEntry[] {
  return listFeatureConfigs(packageRoot).map((config) => ({
    id: config.id,
    name: config.name,
    category: config.category ?? null,
    description: config.description ?? null,
  }))
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

export function suggestFeature(
  featureId: string,
  packageRoot: string = featurePackageRoot(),
): string | null {
  let closest: string | null = null
  let closestDistance = Number.POSITIVE_INFINITY
  for (const feature of listFeatureConfigs(packageRoot)) {
    const distance = editDistance(featureId, feature.id)
    if (distance < closestDistance) {
      closest = feature.id
      closestDistance = distance
    }
  }
  const threshold = Math.max(2, Math.floor(featureId.length / 3))
  return closest !== null && closestDistance <= threshold ? closest : null
}

function resolveTargetDir(raw: string): string {
  return isAbsolute(raw) ? raw : resolve(raw)
}

export function resolveFeatureDestPath(fileDest: string, route: FeatureConfig['route']): string {
  const pages = 'src/pages/'
  const appPages = 'src/pages/(app)/'
  if (!fileDest.startsWith(pages) || fileDest.startsWith(appPages)) return fileDest
  const rest = fileDest.slice(pages.length)
  return route?.protected === false ? `${appPages}${rest}` : `${appPages}(protected)/${rest}`
}

function copyFile(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}

function copyFileWithImportShift(src: string, dest: string, levels: number): void {
  mkdirSync(dirname(dest), { recursive: true })
  const prefix = '../'.repeat(levels)
  const shifted = readFileSync(src, 'utf-8').replace(
    /(from\s+|import\s+|import\()(['"])(\.\.\/)/g,
    `$1$2${prefix}$3`,
  )
  writeFileSync(dest, shifted)
}

function installFiles(
  packageRoot: string,
  config: FeatureConfig,
  targetDir: string,
  emit: FeatureInstallerOutput,
): {
  copied: number
  skipped: number
  files: { created: string[]; preexisting: string[]; missing: string[] }
} {
  let copied = 0
  let skipped = 0
  const created: string[] = []
  const preexisting: string[] = []
  const missing: string[] = []

  for (const file of config.files) {
    const srcPath = join(packageRoot, 'features', config.id, file.src)
    const resolvedDest = resolveFeatureDestPath(file.dest, config.route)
    const destPath = join(targetDir, resolvedDest)
    const existed = existsSync(destPath)
    if (existed) preexisting.push(resolvedDest)

    if (!existsSync(srcPath)) {
      emit(`   Warning: source not found: ${file.src}`, 'stderr')
      if (!existed) missing.push(resolvedDest)
      continue
    }

    if (existed && !file.overwrite) {
      emit(`   Exists (skipped): ${resolvedDest}`)
      skipped++
      continue
    }

    const wasRedirected = resolvedDest !== file.dest
    const shiftLevels = resolvedDest.split('/').length - file.dest.split('/').length
    if (wasRedirected) copyFileWithImportShift(srcPath, destPath, shiftLevels)
    else copyFile(srcPath, destPath)
    emit(`   ${existed ? 'Overwrote' : 'Copied'}: ${resolvedDest}`)
    if (!existed) created.push(resolvedDest)
    copied++
  }

  return { copied, skipped, files: { created, preexisting, missing } }
}

function unresolvedSchema(
  schema: FeatureSchema,
  reason: string,
  emit: FeatureInstallerOutput,
): UnresolvedIntegration {
  const entry = schema.spreadOperator ? `...${schema.exportName}` : schema.exportName
  emit('')
  emit('   Add manually to src/schemas.ts:')
  emit(`     import { ${schema.exportName} } from '${schema.importPath}'`)
  emit(`     // then add ${entry} to the schemas array`)
  return {
    area: 'schema',
    reason,
    steps: [
      `Add import { ${schema.exportName} } from '${schema.importPath}' to src/schemas.ts.`,
      `Add ${entry} to the exported schemas array.`,
    ],
  }
}

function integrateSchema(
  config: FeatureConfig,
  targetDir: string,
  emit: FeatureInstallerOutput,
): UnresolvedIntegration[] {
  if (!config.schema) return []
  const schemasPath = join(targetDir, 'src', 'schemas.ts')
  if (!existsSync(schemasPath)) {
    return [unresolvedSchema(config.schema, 'src/schemas.ts was not found.', emit)]
  }

  let content = readFileSync(schemasPath, 'utf-8')
  const { exportName, importPath, spreadOperator } = config.schema
  const importPattern = new RegExp(`^import\\s+\\{[^}]*\\b${exportName}\\b`, 'm')
  if (importPattern.test(content)) {
    emit(`   Schema already present: ${exportName}`)
    return []
  }
  if (
    !content.includes('export const schemas') ||
    !/export const schemas:\s*CollectionSchema\[\]\s*=\s*\[/.test(content)
  ) {
    const reason = 'src/schemas.ts has an unexpected structure.'
    emit(`   Could not auto-integrate schema (${reason})`)
    return [unresolvedSchema(config.schema, reason, emit)]
  }

  const importLine = `import { ${exportName} } from '${importPath}'`
  const withImport = content.replace(
    /export const schemas/,
    `${importLine}\n\nexport const schemas`,
  )
  const schemaEntry = spreadOperator ? `...${exportName}` : exportName
  const withEntry = withImport.replace(
    /export const schemas:\s*CollectionSchema\[\]\s*=\s*\[/,
    `export const schemas: CollectionSchema[] = [\n  ${schemaEntry},`,
  )
  if (withImport === content || withEntry === withImport) {
    const reason = 'src/schemas.ts could not be updated safely.'
    emit(`   Could not auto-integrate schema (${reason})`)
    return [unresolvedSchema(config.schema, reason, emit)]
  }
  content = withEntry
  writeFileSync(schemasPath, content)
  emit(`   Schema integrated: ${exportName} -> schemas.ts`)
  return []
}

function unresolvedActions(
  actions: FeatureAction[],
  reason: string,
  emit: FeatureInstallerOutput,
): UnresolvedIntegration {
  emit('')
  emit('   Add manually to src/actions/index.ts:')
  for (const action of actions) {
    emit(`     import { ${action.exportName} } from '${action.importPath}'`)
    emit(`     // then add '${action.registerAs}': ${action.exportName} to the actions object`)
  }
  return {
    area: 'actions',
    reason,
    steps: actions.flatMap((action) => [
      `Add import { ${action.exportName} } from '${action.importPath}' to src/actions/index.ts.`,
      `Register '${action.registerAs}': ${action.exportName} in the exported actions object.`,
    ]),
  }
}

function integrateActions(
  config: FeatureConfig,
  targetDir: string,
  emit: FeatureInstallerOutput,
): UnresolvedIntegration[] {
  if (!config.actions?.length) return []
  const actionsPath = join(targetDir, 'src', 'actions', 'index.ts')
  if (!existsSync(actionsPath)) {
    return [unresolvedActions(config.actions, 'src/actions/index.ts was not found.', emit)]
  }

  let content = readFileSync(actionsPath, 'utf-8')
  const registryPattern =
    /export const actions:\s*Record<string,\s*ActionHandler(?:<[^>]*>)?>\s*=\s*\{/
  if (!registryPattern.test(content)) {
    const reason = 'src/actions/index.ts has an unexpected structure.'
    emit(`   Could not auto-integrate actions (${reason})`)
    return [unresolvedActions(config.actions, reason, emit)]
  }

  let integrated = 0
  const unresolved: UnresolvedIntegration[] = []
  for (const action of config.actions) {
    const importPattern = new RegExp(`^import\\s+\\{[^}]*\\b${action.exportName}\\b`, 'm')
    if (importPattern.test(content)) {
      emit(`   Action already present: ${action.registerAs}`)
      continue
    }
    const importLine = `import { ${action.exportName} } from '${action.importPath}'`
    const withImport = content.replace(
      /export const actions:/,
      `${importLine}\n\nexport const actions:`,
    )
    const registryEntry = `  '${action.registerAs}': ${action.exportName},`
    const withEntry = withImport.replace(registryPattern, (match) => `${match}\n${registryEntry}`)
    if (withImport === content || withEntry === withImport) {
      emit(`   Could not integrate action: ${action.registerAs}`)
      unresolved.push(
        unresolvedActions(
          [action],
          `Action '${action.registerAs}' could not be registered safely.`,
          emit,
        ),
      )
      continue
    }
    content = withEntry
    integrated++
    emit(`   Action integrated: ${action.registerAs} (${action.exportName})`)
  }
  if (integrated > 0) writeFileSync(actionsPath, content)
  return unresolved
}

function integrateCode(
  config: FeatureConfig,
  targetDir: string,
  emit: FeatureInstallerOutput,
): UnresolvedIntegration[] {
  const unresolved: UnresolvedIntegration[] = []
  for (const insertion of config.code ?? []) {
    const targetPath = join(targetDir, insertion.file)
    if (!existsSync(targetPath)) {
      unresolved.push({
        area: 'code',
        reason: `${insertion.file} was not found.`,
        steps: [`Add ${insertion.insert.trim()} to ${insertion.file}.`],
      })
      continue
    }

    const original = readFileSync(targetPath, 'utf-8')
    if (original.includes(insertion.insert.trim())) {
      emit(`   Integration already present: ${insertion.file}`)
      continue
    }
    const markerIndex = original.indexOf(insertion.marker)
    if (markerIndex < 0) {
      unresolved.push({
        area: 'code',
        reason: `${insertion.file} does not contain the expected insertion point.`,
        steps: [
          ...(insertion.import ? [`Add ${insertion.import} to ${insertion.file}.`] : []),
          `Add ${insertion.insert.trim()} to ${insertion.file}.`,
        ],
      })
      continue
    }

    let content = original
    if (insertion.import && !content.includes(insertion.import)) {
      const importIndex = content.search(/^import\s/m)
      content = `${content.slice(0, importIndex < 0 ? 0 : importIndex)}${insertion.import}\n${
        content.slice(importIndex < 0 ? 0 : importIndex)
      }`
    }
    const currentMarkerIndex = content.indexOf(insertion.marker)
    const insertAt =
      insertion.placement === 'before'
        ? currentMarkerIndex
        : currentMarkerIndex + insertion.marker.length
    const prefix = insertion.placement === 'before' ? '' : '\n'
    const suffix = insertion.placement === 'before' ? '\n' : ''
    content = `${content.slice(0, insertAt)}${prefix}${insertion.insert}${suffix}${content.slice(insertAt)}`
    writeFileSync(targetPath, content)
    emit(`   Integrated: ${insertion.file}`)
  }
  return unresolved
}

function integrateIgnore(config: FeatureConfig, targetDir: string): void {
  if (!config.ignore?.length) return
  const targetPath = join(targetDir, '.gitignore')
  const current = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : ''
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()))
  const missing = config.ignore.filter((pattern) => !present.has(pattern))
  if (missing.length === 0) return
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  writeFileSync(targetPath, `${current}${separator}${missing.join('\n')}\n`)
}

function integrateWrangler(
  config: FeatureConfig,
  targetDir: string,
  emit: FeatureInstallerOutput,
): UnresolvedIntegration[] {
  const runWorkerFirst = config.wrangler?.runWorkerFirst === true
  const rateLimits = config.wrangler?.rateLimits ?? []
  if (!runWorkerFirst && rateLimits.length === 0) return []
  const targetPath = join(targetDir, 'wrangler.toml')
  const steps = [
    ...(runWorkerFirst ? ['Set assets.run_worker_first = true in wrangler.toml.'] : []),
    ...rateLimits.map((binding) => `Add the ${binding.name} rate-limit binding to wrangler.toml.`),
  ]
  if (!existsSync(targetPath)) {
    return [{ area: 'wrangler', reason: 'wrangler.toml was not found.', steps }]
  }

  let source = readFileSync(targetPath, 'utf-8')
  if (runWorkerFirst && !/^\[assets\]\s*$/m.test(source)) {
    return [{ area: 'wrangler', reason: 'wrangler.toml has no [assets] section.', steps }]
  }

  let changed = false
  if (runWorkerFirst) {
    const updated = setRunWorkerFirst(source)
    changed ||= updated !== source
    source = updated
  }

  const scopes = ['', ...wranglerEnvironmentNames(source)]
  for (const scope of scopes) {
    for (const binding of rateLimits) {
      if (hasRateLimitBinding(source, scope, binding.name)) continue
      source = `${source.trimEnd()}\n\n${rateLimitBindingBlock(scope, binding)}\n`
      changed = true
    }
  }

  if (changed) {
    writeFileSync(targetPath, source)
    emit('   Integrated: wrangler.toml')
  } else emit('   Integration already present: wrangler.toml')
  return []
}

function setRunWorkerFirst(source: string): string {
  const headers = [...source.matchAll(/^\[(?:env\.[^\]]+\.)?assets\]\s*$/gm)]
  for (const header of headers.reverse()) {
    const start = header.index
    const bodyStart = start + header[0].length
    const nextHeader = source.slice(bodyStart).search(/^\[\[?[^\]]+\]\]?\s*$/m)
    const end = nextHeader < 0 ? source.length : bodyStart + nextHeader
    const section = source.slice(start, end)
    if (/^\s*run_worker_first\s*=\s*true(?:\s*#.*)?$/m.test(section)) continue
    // Quoted strings are consumed atomically so a `]` inside a route string
    // cannot truncate the array match.
    const setting =
      /^(\s*)run_worker_first\s*=\s*(?:false|\[(?:[^\]"']|"(?:[^"\\]|\\[\s\S])*"|'[^']*')*\])(\s*(?:#.*)?)$/m
    const updated = setting.test(section)
      ? section.replace(setting, '$1run_worker_first = true$2')
      : section.replace(/^\[(?:env\.[^\]]+\.)?assets\]\s*$/m, '$&\nrun_worker_first = true')
    source = source.slice(0, start) + updated + source.slice(end)
  }
  return source
}

function wranglerEnvironmentNames(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/^\[\[?env\.([^.\]]+)(?:\.|\]\]?\s*$)/gm)].map((match) => match[1]),
    ),
  ]
}

function hasRateLimitBinding(source: string, scope: string, name: string): boolean {
  const header = scope ? `[[env.${scope}.ratelimits]]` : '[[ratelimits]]'
  // Tolerate hand-reformatted spacing and either TOML string quoting so a
  // reinstall never appends a duplicate block Wrangler would reject.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const namePattern = new RegExp(
    `^\\s*name\\s*=\\s*(?:"${escaped}"|'${escaped}')\\s*(?:#.*)?$`,
    'm',
  )
  let offset = 0
  while ((offset = source.indexOf(header, offset)) >= 0) {
    const end = source.slice(offset + header.length).search(/^\[/m)
    const blockEnd = end < 0 ? source.length : offset + header.length + end
    if (namePattern.test(source.slice(offset, blockEnd))) return true
    offset += header.length
  }
  return false
}

function rateLimitBindingBlock(
  scope: string,
  binding: NonNullable<FeatureWranglerIntegration['rateLimits']>[number],
): string {
  const header = scope ? `[[env.${scope}.ratelimits]]` : '[[ratelimits]]'
  return [
    header,
    `name = ${JSON.stringify(binding.name)}`,
    `namespace_id = ${JSON.stringify(binding.namespaceId)}`,
    `simple = { limit = ${binding.limit}, period = ${binding.period} }`,
  ].join('\n')
}

function integrateCss(
  packageRoot: string,
  config: FeatureConfig,
  targetDir: string,
  emit: FeatureInstallerOutput,
): UnresolvedIntegration[] {
  if (!config.css?.length) return []
  const stylesPath = join(targetDir, 'src', 'styles.css')
  if (!existsSync(stylesPath)) {
    emit('   Warning: Cannot integrate CSS — src/styles.css not found')
    return [
      {
        area: 'css',
        reason: 'src/styles.css was not found.',
        steps: config.css.map(
          (cssFile) =>
            `Append node_modules/deepspace/features/${config.id}/${cssFile} to src/styles.css.`,
        ),
      },
    ]
  }

  let styles = readFileSync(stylesPath, 'utf-8')
  let integrated = 0
  const unresolved: UnresolvedIntegration[] = []
  for (const cssFile of config.css) {
    const srcPath = join(packageRoot, 'features', config.id, cssFile)
    if (!existsSync(srcPath)) {
      emit(`   Warning: CSS source not found: ${cssFile}`, 'stderr')
      unresolved.push({
        area: 'css',
        reason: `Feature CSS source '${cssFile}' was not found in the installed package.`,
        steps: ['Reinstall the current deepspace package, then retry this feature installation.'],
      })
      continue
    }
    const css = readFileSync(srcPath, 'utf-8')
    const fingerprint = css.match(/\.([\w-]+)\s*\{|@keyframes\s+([\w-]+)/)
    const marker = fingerprint?.[1] ?? fingerprint?.[2]
    if (marker && styles.includes(marker)) {
      emit(`   CSS already present: ${cssFile} (found .${marker})`)
      continue
    }
    styles += `\n${css}`
    integrated++
    emit(`   CSS integrated: ${cssFile} -> styles.css`)
  }
  if (integrated > 0) writeFileSync(stylesPath, styles)
  return unresolved
}

function unresolvedRoute(
  route: NonNullable<FeatureConfig['route']>,
  config: FeatureConfig,
  reason: string,
  emit: FeatureInstallerOutput,
): UnresolvedIntegration {
  emit('')
  emit('   Add manually to src/nav.ts:')
  emit(`     { path: '${route.path}', label: '${config.name}' },`)
  return {
    area: 'nav',
    reason,
    steps: [`Add { path: '${route.path}', label: '${config.name}' } to the exported nav array.`],
  }
}

function integrateRoute(
  config: FeatureConfig,
  targetDir: string,
  emit: FeatureInstallerOutput,
): UnresolvedIntegration[] {
  if (!config.route) return []
  const navPath = join(targetDir, 'src', 'nav.ts')
  if (!existsSync(navPath)) {
    return [unresolvedRoute(config.route, config, 'src/nav.ts was not found.', emit)]
  }
  let content = readFileSync(navPath, 'utf-8')
  const routePath = config.route.path
  if (content.includes(`'${routePath}'`)) {
    emit(`   Nav already present: ${routePath}`)
    return []
  }
  if (!content.includes(NAV_MARKER)) {
    emit('   Could not auto-wire nav (marker not found in nav.ts)')
    return [
      unresolvedRoute(
        config.route,
        config,
        'The feature insertion marker was not found in src/nav.ts.',
        emit,
      ),
    ]
  }
  const roles = config.route.protected === false ? '' : ", roles: ['member' as Role]"
  const entry = `  { path: '${routePath}', label: '${config.name}'${roles} },`
  content = content.replace(NAV_MARKER, `${NAV_MARKER}\n${entry}`)
  writeFileSync(navPath, content)
  emit(`   Nav wired: ${routePath} (${config.name})`)
  emit('   Route: automatic (file-based routing via src/pages/)')
  return []
}

const INSTALL_DIAGNOSTIC_BYTES = 16 * 1024

interface PackageInstallRun {
  error?: Error
  status: number | null
  diagnosticTail?: string
}

function readDiagnosticTail(outputFd: number): string | undefined {
  const size = fstatSync(outputFd).size
  if (size === 0) return undefined
  const length = Math.min(size, INSTALL_DIAGNOSTIC_BYTES)
  const buffer = Buffer.alloc(length)
  readSync(outputFd, buffer, 0, length, size - length)
  const tail = buffer.toString('utf-8').trim()
  if (!tail) return undefined
  return size > length ? `[last ${length} bytes]\n${tail}` : tail
}

function runPackageInstall(
  packageManager: string,
  targetDir: string,
  outputVisible: boolean,
): PackageInstallRun {
  const options = {
    cwd: targetDir,
    shell: process.platform === 'win32',
  }
  if (outputVisible) {
    const child = spawnSync(packageManager, ['install'], { ...options, stdio: 'inherit' })
    return { error: child.error, status: child.status }
  }

  // Keep stdout reserved for the command's one-line JSON envelope. Both child
  // streams share a temporary file, then only a fixed-size tail enters memory.
  const captureDir = mkdtempSync(join(tmpdir(), 'deepspace-add-install-'))
  let outputFd: number | undefined
  try {
    outputFd = openSync(join(captureDir, 'output.log'), 'w+')
    const child = spawnSync(packageManager, ['install'], {
      ...options,
      stdio: ['ignore', outputFd, outputFd],
    })
    return {
      error: child.error,
      status: child.status,
      diagnosticTail: readDiagnosticTail(outputFd),
    }
  } finally {
    if (outputFd !== undefined) closeSync(outputFd)
    rmSync(captureDir, { recursive: true, force: true })
  }
}

function integrateDependencies(
  config: FeatureConfig,
  targetDir: string,
  runInstall: boolean,
  outputVisible: boolean,
  emit: FeatureInstallerOutput,
): {
  added: DependencyAddition[]
  installRan: boolean
  installError?: string
  diagnosticTail?: string
  packageManager: string
} {
  const packageManager = detectPackageManager(targetDir)
  const declarations: Array<{
    section: DependencySection
    values: Record<string, string> | undefined
  }> = [
    { section: 'dependencies', values: config.dependencies },
    { section: 'devDependencies', values: config.devDependencies },
  ]
  if (declarations.every(({ values }) => !values || Object.keys(values).length === 0)) {
    return { added: [], installRan: false, packageManager }
  }

  const packagePath = join(targetDir, 'package.json')
  if (!existsSync(packagePath)) {
    emit('   Could not patch package.json (file not found)')
    return { added: [], installRan: false, packageManager }
  }

  let pkg: Record<string, unknown> & {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  try {
    pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as typeof pkg
  } catch (error) {
    emit(
      `   Could not patch package.json (parse error: ${error instanceof Error ? error.message : String(error)})`,
    )
    return { added: [], installRan: false, packageManager }
  }

  const added: DependencyAddition[] = []
  const skipped: string[] = []
  for (const { section, values } of declarations) {
    if (!values) continue
    pkg[section] ??= {}
    for (const [name, version] of Object.entries(values)) {
      if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) {
        if (!added.some((dependency) => dependency.name === name)) skipped.push(name)
        continue
      }
      pkg[section]![name] = version
      added.push({ name, section, version })
    }
  }

  if (added.length === 0) {
    emit('   Dependencies already present')
  } else {
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
    emit(`   Added to package.json: ${added.map(({ name }) => name).join(', ')}`)
    if (skipped.length) emit(`   Already present (kept your version): ${skipped.join(', ')}`)
  }

  if (!runInstall) return { added, installRan: false, packageManager }
  emit('')
  emit(`   Installing dependencies with ${packageManager}...`)
  const child = runPackageInstall(packageManager, targetDir, outputVisible)
  if (child.error) {
    const error = child.error as NodeJS.ErrnoException
    const reason = error.code === 'ENOENT' ? `${packageManager} not found on PATH` : error.message
    return {
      added,
      installRan: false,
      installError: `Could not launch ${packageManager} (${reason}).`,
      diagnosticTail: child.diagnosticTail,
      packageManager,
    }
  }
  if (child.status !== 0) {
    const diagnostic = child.diagnosticTail ? `\nDiagnostic tail:\n${child.diagnosticTail}` : ''
    return {
      added,
      installRan: false,
      installError: `${packageManager} install did not complete (exit ${child.status ?? 'unknown'}).${diagnostic}`,
      diagnosticTail: child.diagnosticTail,
      packageManager,
    }
  }
  return { added, installRan: true, packageManager }
}

function dependencySnapshot(targetDir: string): {
  dependencies: Record<string, unknown>
  devDependencies: Record<string, unknown>
} {
  try {
    const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return {
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    }
  } catch {
    return { dependencies: {}, devDependencies: {} }
  }
}

function installedNavFeatures(packageRoot: string, targetDir: string): string[] {
  return listFeatureConfigs(packageRoot)
    .filter((feature) => feature.category === 'nav' && feature.files.length > 0)
    .filter((feature) => {
      const signature = resolveFeatureDestPath(feature.files[0].dest, feature.route)
      return existsSync(join(targetDir, signature))
    })
    .map((feature) => feature.id)
}

function warnNavConflicts(
  packageRoot: string,
  config: FeatureConfig,
  targetDir: string,
  emit: FeatureInstallerOutput,
): void {
  if (config.category !== 'nav') return
  const present = installedNavFeatures(packageRoot, targetDir)
  if (present.length <= 1) return
  emit('')
  emit(`⚠ Multiple navigation features present (${present.join(', ')}).`)
  emit('  sidebar, topbar, and tree are mutually exclusive — keep one and remove the')
  emit('  others to avoid competing navigation in your layout.')
}

export function installFeature(options: FeatureInstallOptions): FeatureInstallOutcome {
  const packageRoot = featurePackageRoot()
  const targetDir = resolveTargetDir(options.targetDir)
  const config = readFeatureConfig(options.feature, packageRoot)
  if (!config) {
    const suggestion = suggestFeature(options.feature, packageRoot)
    return {
      ok: false,
      code: 'unknown_feature',
      error: [
        `Unknown feature: ${options.feature}`,
        ...(suggestion ? [`Did you mean "${suggestion}"?`] : []),
      ].join('\n'),
      data: {
        requestedFeature: options.feature,
        suggestedFeature: suggestion,
        availableFeatures: featureCatalog(packageRoot),
      },
    }
  }

  const emit: FeatureInstallerOutput = options.emit ?? (() => undefined)
  emit('')
  emit(`Installing: ${config.name}`)
  emit(`   ${config.description ?? ''}`)
  emit(`   Target: ${targetDir}`)

  const installedFiles = installFiles(packageRoot, config, targetDir, emit)
  integrateIgnore(config, targetDir)
  emit('')
  emit(
    `Copied ${installedFiles.copied} file(s)${
      installedFiles.skipped > 0 ? `, skipped ${installedFiles.skipped} existing` : ''
    }`,
  )

  const unresolvedIntegrations = [
    ...integrateSchema(config, targetDir, emit),
    ...integrateActions(config, targetDir, emit),
    ...integrateWrangler(config, targetDir, emit),
    ...integrateCode(config, targetDir, emit),
    ...integrateCss(packageRoot, config, targetDir, emit),
    ...integrateRoute(config, targetDir, emit),
  ]
  const dependencyResult = integrateDependencies(
    config,
    targetDir,
    options.installDependencies,
    options.emit !== undefined,
    emit,
  )

  if (config.instructions?.length) {
    emit('')
    emit('--- Manual wiring needed ---')
    emit('')
    config.instructions.forEach((instruction, index) => {
      emit(`${index + 1}. ${instruction}`)
      emit('')
    })
  }
  if (config.patterns?.length) {
    emit('--- Key patterns ---')
    emit('')
    config.patterns.forEach((pattern) => emit(`- ${pattern}`))
    emit('')
  }
  warnNavConflicts(packageRoot, config, targetDir, emit)

  const dependenciesAfter = dependencySnapshot(targetDir)
  const declaredDependencies = [
    ...Object.keys(config.dependencies ?? {}),
    ...Object.keys(config.devDependencies ?? {}),
  ]
  const missingDeclarations = declaredDependencies.filter(
    (name) =>
      !(name in dependenciesAfter.dependencies) && !(name in dependenciesAfter.devDependencies),
  )
  const installed =
    installedFiles.files.missing.length === 0 &&
    missingDeclarations.length === 0 &&
    unresolvedIntegrations.length === 0 &&
    dependencyResult.installError === undefined
  const dependencyInstallRequired =
    installed &&
    dependencyResult.added.length > 0 &&
    !options.installDependencies &&
    !dependencyResult.installRan

  const data: InstallData = {
    feature: config.id,
    dir: targetDir,
    installed,
    observedChanges: {
      files: installedFiles.files,
      dependencies: {
        added: dependencyResult.added,
        missingDeclarations,
        installRequested: options.installDependencies,
        ...(dependencyResult.diagnosticTail
          ? { diagnosticTail: dependencyResult.diagnosticTail }
          : {}),
      },
    },
    unresolvedIntegrations,
    manifestGuidance: {
      instructions: config.instructions ?? [],
      patterns: config.patterns ?? [],
      agentNotes: config.agentNotes ?? [],
    },
  }
  if (dependencyResult.installError) {
    return {
      ok: false,
      code: 'dependency_install_failed',
      error: dependencyResult.installError,
      data,
    }
  }
  if (unresolvedIntegrations.length > 0) {
    const count = unresolvedIntegrations.length
    return {
      ok: false,
      code: 'manual_integration_required',
      error: `${count} app integration${count === 1 ? '' : 's'} require manual completion. Follow the unresolved integration steps, then run your checks.`,
      data,
    }
  }

  return {
    ok: true,
    data,
    ...(dependencyInstallRequired
      ? {
          action: {
            cwd: targetDir,
            argv: [dependencyResult.packageManager, 'install'],
          },
        }
      : {}),
  }
}
