import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as p from '@clack/prompts'
import spawn from 'cross-spawn'
import { detectBun, resolveInstall } from './install-cmd'
import type { PreparedProject, Progress } from './project-template'

// This focused upstream installer intentionally floats: pinning it would make
// every installer fix require a create-deepspace release.
const SKILLS_INSTALLER_PACKAGE = 'skills@latest'
const SKILL_REPOSITORY = 'deepdotspace/deepspace-skill'

interface InstallerCommand {
  command: string
  args: string[]
}

/** Avoid a nested `npx` shim when the creator itself is running under npm exec. */
export function agentSkillInstallerCommand(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): InstallerCommand {
  const args = [
    'exec',
    '--yes',
    `--package=${SKILLS_INSTALLER_PACKAGE}`,
    '--',
    'skills',
    'add',
    SKILL_REPOSITORY,
    '-y',
  ]
  const npmExecPath = environment.npm_execpath
  return npmExecPath && /(?:^|[/\\])npm-cli\.(?:c?js|mjs)$/i.test(npmExecPath)
    ? { command: process.execPath, args: [npmExecPath, ...args] }
    : { command: 'npm', args }
}

export function createProgress(): Progress {
  // Clack repaints a TTY spinner with carriage returns. In agent/CI logs those
  // become thousands of lines, so non-TTY callers get one line per phase.
  if (process.stdout.isTTY) return p.spinner()
  return {
    start: (message) => {
      if (message) console.log(message)
    },
    stop: (message) => {
      if (message) console.log(message)
    },
  }
}

export async function completeProjectSetup(
  project: PreparedProject,
  progress: Progress,
): Promise<void> {
  await installAgentSkill(project.appDir, progress)
  installDependencies(project.appDir)
  // A scaffold comes out IDENTITY-LESS, always. `wrangler.toml` keeps the
  // `__APP_ID__` placeholder and the repo keeps its unborn HEAD; the first
  // verb that needs an id (deploy, dev, secrets…) mints one under the login
  // that shell holds and stamps it there — the ONLY place the id lives.
  // Registering here instead would spend an app slot before the user has run
  // a single command, and would bind the app to whatever login happened to be
  // ambient during `npm create`.
  printNextSteps(project)
}

async function installAgentSkill(appDir: string, progress: Progress): Promise<void> {
  progress.start('Installing DeepSpace agent skill')
  try {
    assertClaudeSkillLinkAvailable(appDir)
    // Upstream currently needs .claude/ to exist before a project-local install
    // or it can silently skip Claude Code's symlink.
    mkdirSync(join(appDir, '.claude'), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const installer = agentSkillInstallerCommand()
      const child = spawn(installer.command, installer.args, {
        cwd: appDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const maxCapture = 64 * 1024
      let captured = ''
      let truncated = false
      const capture = (chunk: Buffer) => {
        if (truncated) return
        if (captured.length + chunk.length > maxCapture) {
          captured += chunk.toString('utf8').slice(0, maxCapture - captured.length)
          truncated = true
        } else {
          captured += chunk.toString('utf8')
        }
      }
      child.stdout?.on('data', capture)
      child.stderr?.on('data', capture)
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
          return
        }
        const output = captured.trim() + (truncated ? '\n…(truncated)' : '')
        reject(
          new Error(
            `skills add exited with code ${code}` +
              (output ? `\n--- skills output ---\n${output}` : ''),
          ),
        )
      })
      child.on('error', reject)
    })
    ensureClaudeSkillLink(appDir)
    progress.stop('DeepSpace agent skill installed')
  } catch (error) {
    progress.stop(
      'Skill install failed — see .deepspace/skill.err, then run ' +
        `\`npx -y ${SKILLS_INSTALLER_PACKAGE} add ${SKILL_REPOSITORY}\``,
    )
    try {
      mkdirSync(join(appDir, '.deepspace'), { recursive: true })
      const message = error instanceof Error ? error.message : String(error)
      writeFileSync(
        join(appDir, '.deepspace', 'skill.err'),
        message.endsWith('\n') ? message : message + '\n',
      )
    } catch {
      // The progress message still tells the user how to recover.
    }
  }
}

/** Refuse before the external installer can touch a user-owned Claude skill. */
export function assertClaudeSkillLinkAvailable(appDir: string): void {
  const link = join(appDir, '.claude', 'skills', 'deepspace')
  if (!lstatExists(link) || lstatSync(link).isSymbolicLink()) return
  throw new Error(
    '.claude/skills/deepspace already exists and is not a symlink; it was preserved. ' +
      'Move or merge that directory, then rerun the skills installer.',
  )
}

/** Keep every supported agent pointed at the one portable project skill. */
export function ensureClaudeSkillLink(appDir: string): void {
  const source = join(appDir, '.agents', 'skills', 'deepspace')
  if (!existsSync(source))
    throw new Error('skills installer did not create .agents/skills/deepspace')
  const link = join(appDir, '.claude', 'skills', 'deepspace')
  mkdirSync(join(link, '..'), { recursive: true })
  if (existsSync(link) || lstatExists(link)) {
    if (lstatSync(link).isSymbolicLink()) return
    throw new Error(
      '.claude/skills/deepspace already exists and is not a symlink; refusing to replace it.',
    )
  }
  symlinkSync(
    process.platform === 'win32' ? source : '../../.agents/skills/deepspace',
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function installDependencies(appDir: string): void {
  const sentinelDirectory = join(appDir, '.deepspace')
  mkdirSync(sentinelDirectory, { recursive: true })
  writeFileSync(join(sentinelDirectory, 'install.started'), new Date().toISOString() + '\n')

  const { cmd, args } = resolveInstall(detectBun(), process.env.npm_config_user_agent)
  p.log.step(`Installing dependencies (${cmd} ${args.join(' ')})…`)
  writeFileSync(join(sentinelDirectory, 'install.pid'), `${process.pid}\n`)
  const result = spawn.sync(cmd, args, { cwd: appDir, stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    const message = result.error
      ? `${cmd} ${args.join(' ')} failed to start: ${result.error.message}`
      : `${cmd} ${args.join(' ')} exited with code ${result.status}`
    writeFileSync(join(sentinelDirectory, 'install.err'), message + '\n')
    p.log.error(
      'Dependency install failed — run `npm install` (or `bun install`) in the app dir, then retry.',
    )
    throw new Error(message)
  } else {
    writeFileSync(join(sentinelDirectory, 'install.done'), new Date().toISOString() + '\n')
    const sdkVersion = installedSdkVersion(appDir)
    // Name the SDK this app actually runs on, read off disk after the install.
    // The manifest asks for the creator's own version exactly, so this is
    // normally that number — and when it isn't (a `--local` tarball, a
    // resolution the package manager overrode) the scaffold says so instead of
    // leaving the runtime version to be guessed from the creator's.
    p.log.success(`Dependencies installed${sdkVersion ? ` — deepspace ${sdkVersion}` : ''}`)
  }
}

/** The `deepspace` version this scaffold ended up with, straight from the
 *  installed package. Null only if the install left no manifest to read. */
export function installedSdkVersion(appDir: string): string | null {
  const manifest = join(appDir, 'node_modules', 'deepspace', 'package.json')
  if (!existsSync(manifest)) return null
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf-8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null // an unreadable manifest is "unknown", and the outro says so
  }
}

/**
 * The Next-steps list. Pure + exported for its unit test. There is no
 * registration branch left: every scaffold leaves here id-less, so the list is
 * the same for a signed-in and a signed-out shell. The one thing worth saying
 * out loud is WHOSE app it becomes — registration follows the login that
 * shell holds at the moment of first use, not the one that ran `npm create`.
 */
export function nextStepsLines(
  project: Pick<PreparedProject, 'appName' | 'isInPlace'>,
): string[] {
  return [
    ...(project.isInPlace ? [] : [`cd ${project.appName}`]),
    '# The first command that needs an app id registers this app to whichever',
    '# account this shell is logged in as (`npx deepspace auth login` to switch).',
    'npx deepspace dev start',
    '',
    'Deploy:',
    '  npx deepspace deploy',
    '',
    'Add features:',
    '  npx deepspace add --list',
    '  npx deepspace add messaging',
  ]
}

function printNextSteps(project: PreparedProject): void {
  p.note(nextStepsLines(project).join('\n'), 'Next steps')
  p.outro(`${project.appName} is ready — it registers on first use (deploy, dev, secrets…)`)
}
