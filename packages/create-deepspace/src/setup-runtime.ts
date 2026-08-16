import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
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
  // The app id is SERVER-MINTED under the user's login: the just-installed
  // CLI's `app init` asks the platform for an id registered to the caller and
  // stamps it into wrangler.toml + the client constants. Without a login the
  // scaffold stays usable but carries no identity until `app init` succeeds.
  // The initial commit is `app init`'s job (invoked just below):
  // identity must exist before anything is committed,
  // and init commits only a repo whose HEAD is still unborn — so an existing
  // repo (e.g. GitHub-sourced) is never committed into, and a logged-out
  // scaffold stays uncommitted until login + `app init` heal it. Running
  // after the install keeps the lockfile in that first commit.
  const identityRegistered = registerAppIdentity(project.appDir, progress)
  printNextSteps(project, identityRegistered)
}

/**
 * Run the freshly-installed CLI's authed `deepspace app init` — the ONLY
 * place app ids come from (server-authoritative minting). Soft-fails: an
 * offline or logged-out scaffold prints the recovery pair (`auth login`, `app init`)
 * instead of stranding a finished install, and `app init` later heals the
 * remaining `__APP_ID__` placeholders itself.
 */
function registerAppIdentity(appDir: string, progress: Progress): boolean {
  progress.start('Registering app identity')
  const cli = join(appDir, 'node_modules', '.bin', 'deepspace')
  const result = spawn.sync(cli, ['app', 'init'], {
    cwd: appDir,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 120_000,
  })
  if (!result.error && result.status === 0) {
    progress.stop('App identity registered')
    return true
  }
  progress.stop('App identity not registered yet')
  const detail = (result.stderr || result.stdout || result.error?.message || '').trim()
  if (detail) p.log.warn(detail.split('\n').slice(-3).join('\n'))
  p.log.warn(
    'Your app has no id yet, so no initial commit was made. Run `npx deepspace auth login`, ' +
      'then `npx deepspace app init` in the app dir, then commit.',
  )
  return false
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
    p.log.success('Dependencies installed')
  }
}

function printNextSteps(project: PreparedProject, identityRegistered: boolean): void {
  p.note(
    [
      ...(project.isInPlace ? [] : [`cd ${project.appName}`]),
      'npx deepspace auth login',
      ...(identityRegistered ? [] : ['npx deepspace app init']),
      'npx deepspace dev start',
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
  p.outro(`${project.appName} is ready`)
}
