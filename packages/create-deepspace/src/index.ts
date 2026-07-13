/**
 * create-deepspace
 *
 * Scaffolds a new DeepSpace app:
 *   1. Copies embedded starter template
 *   2. Replaces __APP_NAME__ / __APP_ID__ placeholders (the id is a
 *      locally minted ULID — the app's immutable identity; no network needed)
 *   3. Installs dependencies
 *
 * Features are imported from the `deepspace` SDK package, not copied.
 *
 * Usage:
 *   npm create deepspace my-app
 *   create-deepspace my-app --local /path/to/deepspace-sdk
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, cpSync, mkdirSync, openSync, closeSync, statSync } from 'node:fs'
import { join, resolve, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import spawn from 'cross-spawn'
import * as p from '@clack/prompts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = join(__dirname, '..', 'templates')

// Floats intentionally: `skills` is a small, focused upstream installer with
// a stable `add <repo>` CLI surface. Pinning here would require a bump-and-
// publish of `create-deepspace` every time we want a skill-installer fix; in
// exchange for cache freshness we accept the upstream-breakage risk.
const SKILLS_INSTALLER_PKG = 'skills@latest'
const SKILL_REPO = 'deepdotspace/deepspace-skill'

function parseArgs(argv: string[]): {
  appName?: string
  local?: string
  help: boolean
  version: boolean
  interactive: boolean
} {
  let appName: string | undefined
  let local: string | undefined
  let help = false
  let version = false
  let interactive = false

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--local') {
      local = argv[++i]
    } else if (a === '--help' || a === '-h') {
      help = true
    } else if (a === '--version' || a === '-v') {
      version = true
    } else if (a === '--interactive' || a === '-i') {
      interactive = true
    } else if (!a.startsWith('-')) {
      appName = a
    }
  }

  return { appName, local, help, version, interactive }
}

function printHelp(): void {
  // No clack/box-drawing styling: this output is read by agents as well as
  // humans, and a plain `--help` should never produce ANSI noise.
  console.log(`create-deepspace — scaffold a new DeepSpace app

USAGE
  npm create deepspace@latest <app-name>
  npx create-deepspace <app-name> [options]

ARGUMENTS
  <app-name>          Lowercase name (a–z, 0–9, dashes; max 63 chars).
                      Use "." to scaffold into the current directory.

OPTIONS
  -h, --help          Show this help and exit.
  -v, --version       Print the create-deepspace version and exit.
  -i, --interactive   Prompt for missing values instead of erroring.
                      (Default behavior is non-interactive — designed for agents.)
      --local <path>  Use a local SDK monorepo checkout instead of the
                      published deepspace package. Requires a built
                      <path>/packages/deepspace/dist/.

IN-PLACE SCAFFOLDING
  The target dir may already exist if it is "near-empty" — only these
  boilerplate entries are tolerated:
    .git, .gitignore, .gitattributes, .github/, LICENSE*, README*,
    any top-level *.md, docs/, .claude/, .vscode/, .idea/, .editorconfig,
    .vite, .wrangler, .dev.vars, .DS_Store
  On a filename collision (e.g. an existing CLAUDE.md) the existing file
  is kept and the template version is written alongside as
  <name>.deepspace<ext> (e.g. CLAUDE.deepspace.md) for hand-merging.
  .git is allowed but not required; a trailing 'git init' runs only if
  no .git exists yet. Anything else blocks scaffolding and is listed
  in the refusal message.

EXAMPLES
  # From a parent directory, create a new dir:
  npm create deepspace@latest my-app

  # From inside an existing (near-empty) repo, scaffold in place:
  cd my-app && npm create deepspace@latest my-app
  cd my-app && npm create deepspace@latest .

  # SDK contributors testing unreleased changes:
  npx create-deepspace my-app --local ~/code/deepspace-sdk
`)
}

function printMissingAppNameUsage(): void {
  console.error(`error: missing required <app-name> argument

Usage:
  npm create deepspace@latest <app-name>

Examples:
  npm create deepspace@latest my-app
  npm create deepspace@latest .

Run \`npm create deepspace@latest -- --help\` for all options.`)
}

// In a real terminal, @clack/prompts repaints the spinner by writing `\r`
// to overwrite the previous frame. In non-TTY contexts (agents, CI logs,
// pipes, `tee`-ed output) `\r` does nothing and every frame becomes a new
// line — a single install step floods the log with thousands of repeats.
// When stdout is not a TTY we fall back to one static line per phase.
function createSpinner(): { start: (msg?: string) => void; stop: (msg?: string) => void; message: (msg?: string) => void } {
  if (process.stdout.isTTY) return p.spinner()
  return {
    start: (msg?: string) => { if (msg) console.log(msg) },
    stop: (msg?: string) => { if (msg) console.log(msg) },
    message: (msg?: string) => { if (msg) console.log(msg) },
  }
}

function validateAppName(name: string): string | null {
  if (!name) return 'App name is required'
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return 'Name must be lowercase alphanumeric with dashes'
  if (name.length > 63) return 'Name must be 63 characters or less'
  return null
}

const BOILERPLATE_FILES = new Set([
  '.git', '.gitignore', '.gitattributes', 'readme.md', 'readme',
  'license', 'license.md', 'licence', 'licence.md', '.github',
  '.vite', '.wrangler', '.dev.vars', '.ds_store',
  'docs', '.claude', '.vscode', '.idea', '.editorconfig',
])

// One-line version of the allowlist for refusal messages and --help.
const BOILERPLATE_SUMMARY =
  '.git, .gitignore, README*, LICENSE*, any top-level *.md, docs/, .github/, .claude/, editor dotfiles'

/**
 * Entries that make a directory unsafe to scaffold into: anything that is
 * neither boilerplate (BOILERPLATE_FILES) nor a top-level *.md file.
 */
function blockingEntries(dir: string): string[] {
  return readdirSync(dir).filter(
    (name) => !isBoilerplateFileName(name) && extname(name).toLowerCase() !== '.md',
  )
}

function isNearEmpty(dir: string): boolean {
  return blockingEntries(dir).length === 0
}

function isBoilerplateFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return BOILERPLATE_FILES.has(lower) ||
    (lower.startsWith('.wrangler.deepspace.') && lower.endsWith('.toml'))
}

function replaceInDir(dir: string, search: string, replace: string) {
  const textExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.toml', '.html', '.css', '.md'])
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.name === 'node_modules' || entry.name === '.wrangler') continue
    if (entry.isDirectory()) {
      replaceInDir(full, search, replace)
    } else if (textExts.has(extname(entry.name))) {
      const content = readFileSync(full, 'utf-8')
      if (content.includes(search)) {
        writeFileSync(full, content.replaceAll(search, replace))
      }
    }
  }
}

/**
 * Seed `<appDir>/.claude/launch.json` pointing the Claude Code preview tool at
 * this app on the default dev port. Kept in sync with the deepspace CLI's own
 * `writeLaunchConfigIfMissing` (packages/deepspace/src/cli/lib/app-context.ts)
 * — the scaffold seeds it here for the first launch; `deepspace dev` self-heals
 * it for apps that predate this.
 */
function writeLaunchJson(appDir: string, appName: string): void {
  const config = {
    version: '0.0.1',
    configurations: [
      {
        name: appName,
        runtimeExecutable: 'npx',
        runtimeArgs: ['deepspace', 'dev', '--port', '5173'],
        port: 5173,
      },
    ],
  }
  // Best-effort: a launch.json write failure must never abort scaffolding
  // (mirrors the deepspace CLI's writeLaunchConfigIfMissing).
  try {
    const claudeDir = join(appDir, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'launch.json'), JSON.stringify(config, null, 2) + '\n')
  } catch {
    // ignore — the preview tool falls back to its own resolution
  }
}

/**
 * Pack the deepspace package from the monorepo root and return the tarball path.
 */
function packLocal(monorepoRoot: string, appDir: string): string {
  const pkgDir = join(monorepoRoot, 'packages', 'deepspace')
  if (!existsSync(join(pkgDir, 'dist'))) {
    throw new Error(`deepspace not built — run: cd ${pkgDir} && pnpm build`)
  }
  const tgz = execSync('npm pack --pack-destination ' + JSON.stringify(appDir), {
    cwd: pkgDir,
    encoding: 'utf-8',
  }).trim()
  return join(appDir, tgz)
}

async function main() {
  const args = parseArgs(process.argv)

  // Early exits — these must run BEFORE p.intro so plain `--help` / `--version`
  // and the no-args usage path produce no clack/box-drawing output. Agents
  // probing the CLI must get clean stdout, no ANSI noise, no interactive hang.
  if (args.help) { printHelp(); process.exit(0) }
  if (args.version) {
    const ownPkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    console.log(ownPkg.version)
    process.exit(0)
  }

  // No app name and not opting into interactive mode → print usage and bail.
  // Default-non-interactive is intentional: this CLI is invoked by agents far
  // more than humans, and an interactive prompt that hangs forever on a piped
  // stdin is the worst possible default. Humans who want the wizard can pass
  // --interactive (or -i).
  if (!args.appName && !args.interactive) {
    printMissingAppNameUsage()
    process.exit(1)
  }

  p.intro('Create a new DeepSpace app')

  // Get app name
  let appName = args.appName
  if (!appName) {
    // Reachable only with --interactive (guarded above).
    const result = await p.text({
      message: 'What is your app name?',
      placeholder: 'my-app',
      validate: (v) => validateAppName(v ?? '') ?? undefined,
    })
    if (p.isCancel(result)) { p.cancel('Cancelled'); process.exit(0) }
    appName = result as string
  } else if (appName !== '.') {
    const error = validateAppName(appName)
    if (error) { p.cancel(error); process.exit(1) }
  }

  // Two ways to scaffold in-place into an existing near-empty directory:
  //   1. cwd is the target — `cd my-repo && create-deepspace my-repo` (or `.`)
  //   2. a sibling dir is the target — `create-deepspace my-repo` from the parent
  // Near-empty means only boilerplate files (.git, .gitignore, .gitattributes,
  // LICENSE, README, .github/, etc. — see BOILERPLATE_FILES). A `.git` directory
  // is allowed but not required: empty repos and unversioned scaffolding targets
  // both work. We `git init` at the end if no `.git` exists yet. In case 1 the
  // scaffold target is `cwd` itself, NOT `cwd/my-repo`.
  const cwd = process.cwd()
  const cwdName = basename(cwd)
  // Did the user explicitly ask to scaffold in place? (`.`) — used below to
  // refuse rather than silently nest a <cwd>/<cwd> subdir when cwd isn't empty.
  const explicitInPlace = appName === '.'
  if (appName === '.') {
    // Inherit cwd's name, lowercased so it satisfies validateAppName on
    // case-insensitive filesystems (Windows / default macOS) where the user
    // may be sitting in `MyApp/` but we need a publishable lowercase name.
    appName = cwdName.toLowerCase()
    const error = validateAppName(appName)
    if (error) { p.cancel(`${error} (derived from current directory '${cwdName}')`); process.exit(1) }
  }

  const subdirPath = resolve(appName)
  // Case-insensitive equality so Windows / default macOS users sitting in
  // `Action-Coding/` aren't penalized for casing differing from the lowercase
  // appName the validator requires.
  const cwdInPlace = appName.toLowerCase() === cwdName.toLowerCase() && isNearEmpty(cwd)
  // `.` means "scaffold into THIS directory". If it isn't near-empty we must
  // NOT fall through and quietly create a nested <cwd>/<cwd> subdirectory —
  // that's never what the user meant. Refuse with the tolerated-files rule —
  // UNLESS cwd is already a DeepSpace app, in which case the identity guard
  // below owns the (more specific) "already a DeepSpace app" message.
  const cwdWrangler = join(cwd, 'wrangler.toml')
  const cwdIsDeepSpaceApp =
    existsSync(cwdWrangler) && /DEEPSPACE_APP_ID\s*=\s*"app_/.test(readFileSync(cwdWrangler, 'utf-8'))
  if (explicitInPlace && !cwdInPlace && !cwdIsDeepSpaceApp) {
    p.cancel(
      `Can't scaffold in place — the current directory contains entries that block scaffolding:\n` +
        blockingEntries(cwd).map((e) => `    ${e}`).join('\n') +
        `\nOnly boilerplate is tolerated (${BOILERPLATE_SUMMARY}). ` +
        `Move these files, or run \`create-deepspace <name>\` to scaffold into a new subdirectory.`,
    )
    process.exit(1)
  }
  const subdirInPlace =
    !cwdInPlace && existsSync(subdirPath) && statSync(subdirPath).isDirectory() && isNearEmpty(subdirPath)

  const isInPlace = cwdInPlace || subdirInPlace
  const appDir = cwdInPlace ? cwd : subdirPath

  // Identity guard: scaffolding must NEVER mint a new id over an existing
  // app (that forks its data, secrets, and routes). If the target — or the
  // cwd the user is standing in — already carries a DEEPSPACE_APP_ID,
  // refuse with the right next step instead of nesting or clobbering.
  for (const dir of [appDir, cwd]) {
    const wranglerPath = join(dir, 'wrangler.toml')
    if (existsSync(wranglerPath) && /DEEPSPACE_APP_ID\s*=\s*"app_/.test(readFileSync(wranglerPath, 'utf-8'))) {
      p.cancel(
        `${dir === cwd ? 'This directory' : appName} is already a DeepSpace app (wrangler.toml has a DEEPSPACE_APP_ID). ` +
          'Use `npx deepspace deploy` to ship it, or `npx deepspace init --new-id` to fork it as a new app.',
      )
      process.exit(1)
    }
  }

  if (!isInPlace && existsSync(appDir)) {
    const blockers = statSync(appDir).isDirectory() ? blockingEntries(appDir) : null
    p.cancel(
      blockers
        ? `Directory ${appName} already exists with entries that block scaffolding:\n` +
            blockers.map((e) => `    ${e}`).join('\n') +
            `\nOnly boilerplate is tolerated (${BOILERPLATE_SUMMARY}). Move these files and re-run.`
        : `${appName} already exists and is not a directory`,
    )
    process.exit(1)
  }

  // Copy template
  const s = createSpinner()
  const templateDir = join(TEMPLATES_DIR, 'starter')
  if (!existsSync(templateDir)) {
    p.cancel('Starter template not found — this is a bug in create-deepspace')
    process.exit(1)
  }

  s.start(isInPlace ? 'Scaffolding into existing repo' : 'Copying template')
  // Copy per top-level entry so pre-existing files are never clobbered: on a
  // name collision (e.g. an existing CLAUDE.md) the user's file wins and the
  // template version lands alongside as <name>.deepspace<ext>. Collisions are
  // only reachable for allowlisted entries — anything else already refused.
  mkdirSync(appDir, { recursive: true })
  const preserved: string[] = []
  for (const entry of readdirSync(templateDir)) {
    const src = join(templateDir, entry)
    const dest = join(appDir, entry)
    if (existsSync(dest)) {
      const ext = extname(entry)
      const alongside = `${basename(entry, ext)}.deepspace${ext}`
      cpSync(src, join(appDir, alongside), { recursive: true })
      preserved.push(`Kept existing ${entry} — template version written to ${alongside}`)
    } else {
      cpSync(src, dest, { recursive: true })
    }
  }

  // .gitignore is not included in templates (npm strips it), so generate it
  const gitignorePath = join(appDir, '.gitignore')
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, [
      'node_modules',
      'dist',
      '.wrangler',
      '.wrangler.deepspace.*.toml',
      '.dev.vars',
      '.deepspace',
      '.worker-bundle.js',
      '*.tgz',
      // Machine-specific Claude Code state: launch.json is self-healed by
      // `deepspace dev` on every machine (worktree entries carry absolute
      // cwd paths that must never be committed), and worktrees are local
      // checkouts.
      '.claude/launch.json',
      '.claude/worktrees',
      '',
    ].join('\n'))
  }
  s.stop('Template ready')
  for (const msg of preserved) p.log.info(msg)

  // Replace placeholders. The app id is minted locally (a ULID — 80 random
  // bits need no server round-trip to be unique); the first deploy registers
  // it and claims the `name` subdomain (docs: app-identity).
  s.start('Configuring project')
  replaceInDir(appDir, '__APP_NAME__', appName)
  replaceInDir(appDir, '__APP_ID__', mintAppId())

  // Fix package.json
  const pkgPath = join(appDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  pkg.name = appName
  pkg.version = '0.0.1'
  pkg.private = true
  delete pkg.files

  // Rewrite workspace:* deps to published versions. Template uses workspace:*
  // so monorepo contributors see the canonical pnpm/bun signal; users get real versions.
  // create-deepspace and deepspace release lock-step, so own version drives both.
  const ownPkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
  for (const section of ['dependencies', 'devDependencies'] as const) {
    for (const [name, ver] of Object.entries(pkg[section] ?? {})) {
      if (typeof ver === 'string' && ver.startsWith('workspace:')) {
        if (name === 'deepspace') {
          pkg[section][name] = `^${ownPkg.version}`
        } else {
          throw new Error(`No published-version mapping for workspace dep '${name}'`)
        }
      }
    }
  }

  // --local: replace deepspace dep with local tarball (runs after workspace rewrite, wins)
  if (args.local) {
    s.stop('Project configured')
    s.start('Packing local deepspace')
    const tarballPath = packLocal(args.local, appDir)
    pkg.dependencies.deepspace = `file:${tarballPath}`
    s.stop('Local deepspace packed')
  }

  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  if (!args.local) s.stop('Project configured')

  // Features ship inside the `deepspace` npm package (node_modules/deepspace/
  // features/), so the background install below delivers them. The `deepspace
  // add` CLI reads from there directly — no .deepspace/ folder needed.

  // Initialize git BEFORE spawning install — the detached worker survives
  // parent exit but `git init` is fast and best done synchronously so the
  // user's first `git status` works immediately.
  if (!existsSync(join(appDir, '.git'))) {
    try {
      execSync('git init', { cwd: appDir, stdio: 'pipe' })
    } catch {
      // git not available, skip
    }
  }

  // Seed an app-local .claude/launch.json so the Claude Code preview tool
  // launches THIS app. Without it the tool walks up the directory tree and can
  // latch onto an ancestor repo's launch.json — pointing at a different app and
  // port — which bites when a DeepSpace app is scaffolded inside another repo.
  // `deepspace dev` rewrites this with the real port only when it's absent, so
  // this seed governs the very first preview launch.
  writeLaunchJson(appDir, appName)

  // Install the DeepSpace agent skill synchronously, BEFORE the background
  // npm/bun install. Call upstream `skills@latest` directly so we don't have to
  // wait for node_modules — or for npx to download the whole `deepspace` SDK
  // just to run a thin wrapper around the same `skills` binary.
  s.start('Installing DeepSpace agent skill')
  try {
    // Pre-create `.claude/` to work around vercel-labs/skills#1138:
    // upstream's project-local install silently skips the Claude Code
    // symlink when `<baseDir>/.claude/` doesn't exist. Kept inside the try so
    // an mkdir failure surfaces via the spinner + sentinel path.
    mkdirSync(join(appDir, '.claude'), { recursive: true })
    await new Promise<void>((res, rej) => {
      const child = spawn(
        'npx',
        ['-y', SKILLS_INSTALLER_PKG, 'add', SKILL_REPO, '-y'],
        { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      // Buffer stdout+stderr so we can surface them on failure. We don't
      // stream to the user because the clack spinner owns the line; on
      // success the output is discarded. Cap captured output at 64KB so a
      // runaway installer can't balloon memory.
      const MAX_CAPTURE = 64 * 1024
      let captured = ''
      let truncated = false
      const onData = (c: Buffer) => {
        if (truncated) return
        if (captured.length + c.length > MAX_CAPTURE) {
          captured += c.toString('utf8').slice(0, MAX_CAPTURE - captured.length)
          truncated = true
        } else {
          captured += c.toString('utf8')
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('close', (code) => {
        if (code === 0) return res()
        const output = captured.trim() + (truncated ? '\n…(truncated)' : '')
        rej(new Error(
          `skills add exited with code ${code}` +
          (output ? `\n--- skills output ---\n${output}` : ''),
        ))
      })
      child.on('error', rej)
    })
    s.stop('DeepSpace agent skill installed')
  } catch (err) {
    // Non-fatal: scaffold still produces a working project. Persist the
    // failure details to .deepspace/skill.err so the user (or us, if they
    // file an issue) can see what went wrong without re-running.
    s.stop(
      'Skill install failed — see .deepspace/skill.err, then run ' +
        `\`npx -y ${SKILLS_INSTALLER_PKG} add ${SKILL_REPO}\``,
    )
    try {
      mkdirSync(join(appDir, '.deepspace'), { recursive: true })
      const msg = err instanceof Error ? err.message : String(err)
      writeFileSync(join(appDir, '.deepspace', 'skill.err'), msg.endsWith('\n') ? msg : msg + '\n')
    } catch {
      // Best effort — if we can't even write the sentinel, the spinner
      // message above is the user's only signal. Don't crash the scaffold.
    }
  }

  // Kick off `npm/bun install` in a detached background process so the user
  // gets their prompt back immediately. The worker writes sentinel files
  // (.deepspace/install.{started,pid,done,err,log}) and the deepspace CLI (`dev`,
  // `test`, `deploy`, `add`) reads them to print a clear error if the user
  // runs a command before install finishes.
  const sentinelDir = join(appDir, '.deepspace')
  mkdirSync(sentinelDir, { recursive: true })
  writeFileSync(join(sentinelDir, 'install.started'), new Date().toISOString() + '\n')
  const logFd = openSync(join(sentinelDir, 'install.log'), 'w')
  const workerScript = join(__dirname, 'install-worker.js')
  const worker = spawn(process.execPath, [workerScript, appDir], {
    cwd: appDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  // install.pid lets the CLI's install guard tell "still running" from "was
  // killed without writing done/err" (OOM, docker stop, laptop shutdown) —
  // otherwise every command would say "still installing" forever.
  if (worker.pid) writeFileSync(join(sentinelDir, 'install.pid'), `${worker.pid}\n`)
  worker.unref()
  closeSync(logFd)

  p.note(
    [
      'Installing dependencies in the background.',
      `Tail: tail -f ${join('.deepspace', 'install.log')}`,
      '',
      ...(isInPlace ? [] : [`cd ${appName}`]),
      'npx deepspace login',
      'npx deepspace dev',
      '',
      'Deploy:',
      '  npx deepspace deploy',
      '',
      'Add features:',
      '  npx deepspace add --list',
      '  npx deepspace add messaging',
    ].join('\n'),
    'Next steps',
  )
  p.outro(`${appName} is ready`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})


/** `app_` + 26-char ULID (48-bit ms timestamp + 80 random bits, Crockford). */
// Kept in sync by hand with packages/deepspace/src/cli/lib/app-identity.ts —
// this package is deliberately dependency-free.
function mintAppId(now = Date.now()): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let ts = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    ts = alphabet[t % 32] + ts
    t = Math.floor(t / 32)
  }
  const rand = new Uint8Array(10)
  crypto.getRandomValues(rand)
  let rs = ''
  let acc = 0
  let bits = 0
  for (const byte of rand) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      rs += alphabet[(acc >> bits) & 31]
    }
  }
  return `app_${ts}${rs}`.slice(0, 30)
}
