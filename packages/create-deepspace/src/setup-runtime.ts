import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as p from '@clack/prompts'
import spawn from 'cross-spawn'
import { detectBun, resolveInstall, tailHint } from './install-cmd'
import type { PreparedProject, Progress } from './project-template'

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url))

// This focused upstream installer intentionally floats: pinning it would make
// every installer fix require a create-deepspace release.
const SKILLS_INSTALLER_PACKAGE = 'skills@latest'
const SKILL_REPOSITORY = 'deepdotspace/deepspace-skill'

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
  commitInitialScaffold(project.appDir, project.initializedGit)
  const dependencyInstallIsBackground = installDependencies(project.appDir)
  printNextSteps(project, dependencyInstallIsBackground)
}

async function installAgentSkill(appDir: string, progress: Progress): Promise<void> {
  progress.start('Installing DeepSpace agent skill')
  try {
    // Upstream currently needs .claude/ to exist before a project-local install
    // or it can silently skip Claude Code's symlink.
    mkdirSync(join(appDir, '.claude'), { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npx', ['-y', SKILLS_INSTALLER_PACKAGE, 'add', SKILL_REPOSITORY, '-y'], {
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

function commitInitialScaffold(appDir: string, initializedGit: boolean): void {
  if (!initializedGit) return

  // Only commit repositories created by this process. The explicit fallback
  // identity keeps agent sandboxes without global Git config deploy-ready.
  const added = spawn.sync('git', ['add', '-A'], { cwd: appDir, stdio: 'pipe' })
  if (added.error || added.status !== 0) return
  spawn.sync(
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
}

function installDependencies(appDir: string): boolean {
  const sentinelDirectory = join(appDir, '.deepspace')
  mkdirSync(sentinelDirectory, { recursive: true })
  writeFileSync(join(sentinelDirectory, 'install.started'), new Date().toISOString() + '\n')
  const logPath = join(sentinelDirectory, 'install.log')

  // Windows job objects can kill detached descendants when npm create exits;
  // use a foreground install there. POSIX can safely return immediately.
  const background = process.platform !== 'win32'
  if (background) {
    const workerScript = join(SOURCE_DIR, 'install-worker.js')
    const worker = spawn(process.execPath, [workerScript, appDir, logPath], {
      cwd: appDir,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    if (worker.pid) writeFileSync(join(sentinelDirectory, 'install.pid'), `${worker.pid}\n`)
    worker.unref()
    return true
  }

  const { cmd, args } = resolveInstall(detectBun())
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
  } else {
    writeFileSync(join(sentinelDirectory, 'install.done'), new Date().toISOString() + '\n')
    p.log.success('Dependencies installed')
  }
  return false
}

function printNextSteps(project: PreparedProject, backgroundInstall: boolean): void {
  p.note(
    [
      ...(backgroundInstall
        ? [
            'Installing dependencies in the background.',
            `Tail: ${tailHint(join('.deepspace', 'install.log'))}`,
            '',
          ]
        : []),
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
