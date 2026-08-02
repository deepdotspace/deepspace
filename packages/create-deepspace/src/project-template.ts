import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as p from '@clack/prompts'
import spawn from 'cross-spawn'
import { validateAppName, type CliInput } from './cli-input'

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(SOURCE_DIR, '..', 'templates')
const BASE_TEMPLATE_DIR = join(TEMPLATES_DIR, 'base')

export const DEFAULT_TEMPLATE = 'starter'

export interface TemplateMeta {
  name: string
  description: string
  dependencies?: Record<string, string>
}

export interface PreparedProject {
  appDir: string
  appName: string
  isInPlace: boolean
  initializedGit: boolean
}

export interface Progress {
  start: (message?: string) => void
  stop: (message?: string) => void
}

interface PackageJson {
  name: string
  version: string
  private: boolean
  files?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const BOILERPLATE_FILES = new Set([
  '.git',
  '.gitignore',
  '.gitattributes',
  'readme.md',
  'readme',
  'license',
  'license.md',
  'licence',
  'licence.md',
  '.github',
  '.vite',
  '.wrangler',
  '.dev.vars',
  '.ds_store',
  'docs',
  '.claude',
  '.vscode',
  '.idea',
  '.editorconfig',
])

const BOILERPLATE_SUMMARY =
  '.git, .gitignore, README*, LICENSE*, any top-level *.md, docs/, .github/, .claude/, editor dotfiles'

/** All selectable templates, default first, then alphabetical. */
export function listTemplates(): TemplateMeta[] {
  const templates: TemplateMeta[] = []
  for (const entry of readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'base') continue
    const metadata = readTemplateMeta(entry.name)
    if (metadata) templates.push(metadata)
  }
  return templates.sort((left, right) =>
    left.name === DEFAULT_TEMPLATE
      ? -1
      : right.name === DEFAULT_TEMPLATE
        ? 1
        : left.name.localeCompare(right.name),
  )
}

/**
 * Resolve a safe target, assemble its template, configure package identity,
 * and initialize source control. User-owned files are never overwritten.
 */
export function prepareProject(
  input: CliInput,
  creatorVersion: string,
  progress: Progress,
): PreparedProject {
  const target = resolveTarget(input.appName)
  const overlayMeta = readTemplateMeta(input.template)
  if (!existsSync(BASE_TEMPLATE_DIR) || !overlayMeta) {
    p.cancel(
      `Template '${input.template}' is not installed correctly — this is a bug in create-deepspace`,
    )
    process.exit(1)
  }

  progress.start(
    target.isInPlace
      ? `Scaffolding into existing repo (${input.template} template)`
      : `Copying ${input.template} template`,
  )
  mkdirSync(target.appDir, { recursive: true })
  const preserved = copyTemplate(input.template, target.appDir)
  writeGitignoreIfMissing(target.appDir)
  progress.stop('Template ready')
  for (const message of preserved) p.log.info(message)

  progress.start('Configuring project')
  replaceInDir(target.appDir, '__APP_NAME__', target.appName)
  replaceInDir(target.appDir, '__APP_ID__', mintAppId())
  configurePackageJson(
    target.appDir,
    target.appName,
    overlayMeta,
    creatorVersion,
    input.local,
    progress,
  )
  if (!input.local) progress.stop('Project configured')

  const initializedGit = initializeGit(target.appDir)
  writeLaunchJson(target.appDir, target.appName)

  return { ...target, initializedGit }
}

function readTemplateMeta(name: string): TemplateMeta | null {
  const metadataPath = join(TEMPLATES_DIR, name, 'template.json')
  if (!existsSync(metadataPath)) return null
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as TemplateMeta
  return { ...metadata, name }
}

function resolveTarget(requestedAppName: string): Omit<PreparedProject, 'initializedGit'> {
  const cwd = process.cwd()
  const cwdName = basename(cwd)
  const explicitInPlace = requestedAppName === '.'
  let appName = requestedAppName

  if (explicitInPlace) {
    appName = cwdName.toLowerCase()
    const error = validateAppName(appName)
    if (error) {
      p.cancel(`${error} (derived from current directory '${cwdName}')`)
      process.exit(1)
    }
  }

  const subdirectoryPath = resolve(appName)
  const cwdInPlace = appName.toLowerCase() === cwdName.toLowerCase() && isNearEmpty(cwd)
  const cwdWrangler = join(cwd, 'wrangler.toml')
  const cwdIsDeepSpaceApp =
    existsSync(cwdWrangler) &&
    /DEEPSPACE_APP_ID\s*=\s*"app_/.test(readFileSync(cwdWrangler, 'utf-8'))

  if (explicitInPlace && !cwdInPlace && !cwdIsDeepSpaceApp) {
    p.cancel(
      `Can't scaffold in place — the current directory contains entries that block scaffolding:\n` +
        blockingEntries(cwd)
          .map((entry) => `    ${entry}`)
          .join('\n') +
        `\nOnly boilerplate is tolerated (${BOILERPLATE_SUMMARY}). ` +
        `Move these files, or run \`create-deepspace <name>\` to scaffold into a new subdirectory.`,
    )
    process.exit(1)
  }

  const subdirectoryInPlace =
    !cwdInPlace &&
    existsSync(subdirectoryPath) &&
    statSync(subdirectoryPath).isDirectory() &&
    isNearEmpty(subdirectoryPath)
  const isInPlace = cwdInPlace || subdirectoryInPlace
  const appDir = cwdInPlace ? cwd : subdirectoryPath

  // Never mint a new identity over an existing app: that would fork its data,
  // secrets, and routes while looking like an ordinary re-scaffold.
  for (const directory of [appDir, cwd]) {
    const wranglerPath = join(directory, 'wrangler.toml')
    if (
      existsSync(wranglerPath) &&
      /DEEPSPACE_APP_ID\s*=\s*"app_/.test(readFileSync(wranglerPath, 'utf-8'))
    ) {
      p.cancel(
        `${directory === cwd ? 'This directory' : appName} is already a DeepSpace app (wrangler.toml has a DEEPSPACE_APP_ID). ` +
          'Use `npx deepspace deploy` to ship it, or `npx deepspace app init --new-id` to fork it as a new app.',
      )
      process.exit(1)
    }
  }

  if (!isInPlace && existsSync(appDir)) {
    const blockers = statSync(appDir).isDirectory() ? blockingEntries(appDir) : null
    p.cancel(
      blockers
        ? `Directory ${appName} already exists with entries that block scaffolding:\n` +
            blockers.map((entry) => `    ${entry}`).join('\n') +
            `\nOnly boilerplate is tolerated (${BOILERPLATE_SUMMARY}). Move these files and re-run.`
        : `${appName} already exists and is not a directory`,
    )
    process.exit(1)
  }

  return { appName, appDir, isInPlace }
}

function copyTemplate(template: string, appDir: string): string[] {
  const stagingDirectory = mkdtempSync(join(tmpdir(), 'deepspace-template-'))
  const preserved: string[] = []

  try {
    assembleTemplate(template, stagingDirectory)
    for (const entry of readdirSync(stagingDirectory)) {
      const source = join(stagingDirectory, entry)
      const destination = join(appDir, entry)
      if (!existsSync(destination)) {
        cpSync(source, destination, { recursive: true })
        continue
      }

      const extension = extname(entry)
      const alongside = `${basename(entry, extension)}.deepspace${extension}`
      cpSync(source, join(appDir, alongside), { recursive: true })
      preserved.push(`Kept existing ${entry} — template version written to ${alongside}`)
    }
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true })
  }

  return preserved
}

function assembleTemplate(name: string, destination: string): void {
  cpSync(BASE_TEMPLATE_DIR, destination, { recursive: true })
  const overlayDirectory = join(TEMPLATES_DIR, name)
  for (const entry of readdirSync(overlayDirectory)) {
    if (entry === 'template.json') continue
    cpSync(join(overlayDirectory, entry), join(destination, entry), { recursive: true })
  }
}

function configurePackageJson(
  appDir: string,
  appName: string,
  template: TemplateMeta,
  creatorVersion: string,
  localSdkRoot: string | undefined,
  progress: Progress,
): void {
  const packagePath = join(appDir, 'package.json')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as PackageJson
  packageJson.name = appName
  packageJson.version = '0.0.1'
  packageJson.private = true
  delete packageJson.files

  if (template.dependencies) {
    packageJson.dependencies = { ...packageJson.dependencies, ...template.dependencies }
  }

  for (const section of ['dependencies', 'devDependencies'] as const) {
    for (const [dependency, version] of Object.entries(packageJson[section] ?? {})) {
      if (typeof version !== 'string' || !version.startsWith('workspace:')) continue
      if (dependency !== 'deepspace') {
        throw new Error(`No published-version mapping for workspace dep '${dependency}'`)
      }
      packageJson[section]![dependency] = `^${creatorVersion}`
    }
  }

  if (localSdkRoot) {
    progress.stop('Project configured')
    progress.start('Packing local deepspace')
    const tarballPath = packLocal(localSdkRoot, appDir)
    packageJson.dependencies ??= {}
    packageJson.dependencies.deepspace = `file:${tarballPath}`
    progress.stop('Local deepspace packed')
  }

  writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n')
}

function packLocal(monorepoRoot: string, appDir: string): string {
  const packageDirectory = join(monorepoRoot, 'packages', 'deepspace')
  if (!existsSync(join(packageDirectory, 'dist'))) {
    throw new Error(`deepspace not built — run: cd ${packageDirectory} && pnpm build`)
  }

  const packed = spawn.sync('npm', ['pack', '--pack-destination', appDir], {
    cwd: packageDirectory,
    encoding: 'utf-8',
  })
  if (packed.error) throw new Error(`npm pack failed to start: ${packed.error.message}`)
  if (packed.status !== 0) {
    const detail = String(packed.stderr ?? '').trim()
    throw new Error(`npm pack exited with code ${packed.status}${detail ? `: ${detail}` : ''}`)
  }

  const tarballName = String(packed.stdout ?? '')
    .trim()
    .split(/\r?\n/)
    .at(-1)
  if (!tarballName || basename(tarballName) !== tarballName || !tarballName.endsWith('.tgz')) {
    throw new Error(`npm pack returned an invalid tarball name: ${tarballName || '(empty)'}`)
  }
  const tarballPath = join(appDir, tarballName)
  if (!existsSync(tarballPath)) throw new Error(`npm pack did not create ${tarballPath}`)
  return tarballPath
}

function initializeGit(appDir: string): boolean {
  if (existsSync(join(appDir, '.git'))) return false
  const result = spawn.sync('git', ['init'], { cwd: appDir, stdio: 'pipe' })
  return !result.error && result.status === 0
}

function writeLaunchJson(appDir: string, appName: string): void {
  const config = {
    version: '0.0.1',
    configurations: [
      {
        name: appName,
        runtimeExecutable: 'npx',
        runtimeArgs: ['deepspace', 'dev', 'start', '--port', '5173'],
        port: 5173,
      },
    ],
  }

  // Best-effort: the preview tool falls back to its own resolution.
  try {
    const claudeDirectory = join(appDir, '.claude')
    mkdirSync(claudeDirectory, { recursive: true })
    writeFileSync(join(claudeDirectory, 'launch.json'), JSON.stringify(config, null, 2) + '\n')
  } catch {
    // Ignore launch metadata failures; the scaffolded app remains usable.
  }
}

function writeGitignoreIfMissing(appDir: string): void {
  const gitignorePath = join(appDir, '.gitignore')
  if (existsSync(gitignorePath)) return

  writeFileSync(
    gitignorePath,
    [
      'node_modules',
      'dist',
      '.wrangler',
      '.wrangler.deepspace.*.toml',
      '.dev.vars',
      '.dev.vars.*',
      '.deepspace',
      '.worker-bundle.js',
      '*.tgz',
      'src/router.ts',
      'src/modals.tsx',
      '.claude/launch.json',
      '.claude/worktrees',
      '',
    ].join('\n'),
  )
}

function blockingEntries(directory: string): string[] {
  return readdirSync(directory).filter(
    (name) => !isBoilerplateFileName(name) && extname(name).toLowerCase() !== '.md',
  )
}

function isNearEmpty(directory: string): boolean {
  return blockingEntries(directory).length === 0
}

function isBoilerplateFileName(name: string): boolean {
  const lowerName = name.toLowerCase()
  return (
    BOILERPLATE_FILES.has(lowerName) ||
    (lowerName.startsWith('.wrangler.deepspace.') && lowerName.endsWith('.toml'))
  )
}

function replaceInDir(directory: string, search: string, replacement: string): void {
  const textExtensions = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.json',
    '.toml',
    '.html',
    '.css',
    '.md',
  ])
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.name === 'node_modules' || entry.name === '.wrangler') continue
    if (entry.isDirectory()) {
      replaceInDir(path, search, replacement)
      continue
    }
    if (!textExtensions.has(extname(entry.name))) continue
    const content = readFileSync(path, 'utf-8')
    if (content.includes(search)) {
      writeFileSync(path, content.replaceAll(search, replacement))
    }
  }
}

/** `app_` + 26-char ULID (48-bit ms timestamp + 80 random bits, Crockford). */
function mintAppId(now = Date.now()): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let timestamp = ''
  let remainingTime = now
  for (let i = 0; i < 10; i++) {
    timestamp = alphabet[remainingTime % 32] + timestamp
    remainingTime = Math.floor(remainingTime / 32)
  }

  const random = new Uint8Array(10)
  crypto.getRandomValues(random)
  let randomString = ''
  let accumulator = 0
  let bits = 0
  for (const byte of random) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      randomString += alphabet[(accumulator >> bits) & 31]
    }
  }
  return `app_${timestamp}${randomString}`.slice(0, 30)
}
