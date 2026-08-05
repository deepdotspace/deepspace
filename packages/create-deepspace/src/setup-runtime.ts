import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  // A newly initialized repo must not become visible to Codex/Claude worktree
  // creation until its package-manager lockfile exists. Committing before a
  // detached install finished left every fresh scaffold dirty and made an
  // immediate native worktree start from an incomplete initial commit.
  commitInitialScaffold(project.appDir, project.initializedGit)
  printNextSteps(project)
}

async function installAgentSkill(appDir: string, progress: Progress): Promise<void> {
  progress.start('Installing DeepSpace agent skill')
  try {
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

/** Keep every supported agent pointed at the one portable project skill. */
export function ensureClaudeSkillLink(appDir: string): void {
  const source = join(appDir, '.agents', 'skills', 'deepspace')
  if (!existsSync(source)) throw new Error('skills installer did not create .agents/skills/deepspace')
  const link = join(appDir, '.claude', 'skills', 'deepspace')
  mkdirSync(join(link, '..'), { recursive: true })
  if (existsSync(link) || lstatExists(link)) {
    if (lstatSync(link).isSymbolicLink()) return
    rmSync(link, { recursive: true, force: true })
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

function commitInitialScaffold(appDir: string, initializedGit: boolean): void {
  if (!initializedGit) return

  // Only commit repositories created by this process. The explicit fallback
  // identity keeps agent sandboxes without global Git config deploy-ready.
  const added = spawn.sync('git', ['add', '-A'], { cwd: appDir, stdio: 'pipe' })
  if (added.error || added.status !== 0) {
    throw new Error(
      added.error
        ? `git add failed to start: ${added.error.message}`
        : `git add exited with code ${added.status}`,
    )
  }
  const committed = spawn.sync(
    'git',
    [
      '-c',
      'user.name=DeepSpace',
      '-c',
      'user.email=scaffold@deep.space',
      'commit',
      '-m',
      'Initial DeepSpace scaffold',
      '--no-verify',
    ],
    { cwd: appDir, stdio: 'pipe' },
  )
  if (committed.error || committed.status !== 0) {
    throw new Error(
      committed.error
        ? `git commit failed to start: ${committed.error.message}`
        : `git commit exited with code ${committed.status}`,
    )
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

function printNextSteps(project: PreparedProject): void {
  p.note(
    [
      ...(project.isInPlace ? [] : [`cd ${project.appName}`]),
      'npx deepspace auth login',
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
