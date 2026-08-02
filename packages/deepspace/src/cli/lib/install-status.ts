import { Refusal } from './command'
/**
 * Verifies the app's dependencies are installed before running a command that
 * needs them (dev, test, deploy, add).
 *
 * `create-deepspace` runs `npm install` (and the agent-skill installer) in a
 * detached background process so the user gets their prompt back immediately.
 * The background worker writes three sentinels under `<appDir>/.deepspace/`:
 *
 *   install.started — created before the worker is spawned
 *   install.pid     — the worker's pid (liveness check for a killed install)
 *   install.done    — written on successful completion
 *   install.err     — written on failure (contains the error message)
 *   install.log     — combined stdout/stderr of the install
 *
 * The presence of `node_modules/deepspace/package.json` is the ground truth
 * for "ready"; the sentinels only shape the error message.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { detectPackageManager } from './package-manager'

export type InstallState = 'ready' | 'installing' | 'failed' | 'missing'

/** Non-throwing install state for informational surfaces such as status. */
export function installState(appDir: string): InstallState {
  if (resolvesDeepspace(appDir)) return 'ready'
  const sentinelDir = join(appDir, '.deepspace')
  if (existsSync(join(sentinelDir, 'install.err'))) return 'failed'
  if (existsSync(join(sentinelDir, 'install.started'))) {
    if (!existsSync(join(sentinelDir, 'install.done')) && installWorkerAlive(sentinelDir)) {
      return 'installing'
    }
    return 'failed'
  }
  return 'missing'
}

/** How to watch the install log live, per platform: `tail -f` isn't on Windows
 *  (PowerShell's `Get-Content -Wait` is the equivalent). */
export function tailHint(logPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `Get-Content -Wait ${logPath}` : `tail -f ${logPath}`
}

export function ensureInstallReady(appDir: string): void {
  if (resolvesDeepspace(appDir)) return

  const sentinelDir = join(appDir, '.deepspace')
  const errPath = join(sentinelDir, 'install.err')
  const startedPath = join(sentinelDir, 'install.started')
  const donePath = join(sentinelDir, 'install.done')
  const logPath = join(sentinelDir, 'install.log')

  if (existsSync(errPath)) {
    const detail = readFileSync(errPath, 'utf-8').trimEnd()
    const log = existsSync(logPath) ? ` Full log: ${logPath}.` : ''
    throw new Refusal(
      `Background install failed: ${detail}.${log} Run \`npm install\` (or \`bun install\`) manually, then retry.`,
      'install_failed',
      { action: { cwd: appDir, argv: [detectPackageManager(appDir), 'install'] } },
    )
  }

  if (existsSync(startedPath) && !existsSync(donePath)) {
    // A worker that died without writing done/err (OOM, docker stop, laptop
    // shutdown) must not read as "still installing" forever. Every current
    // scaffolder writes a valid install.pid before doing background work.
    if (!installWorkerAlive(sentinelDir)) {
      const log = existsSync(logPath) ? ` See what happened: ${logPath}.` : ''
      throw new Refusal(
        `The background install is no longer running and never finished.${log} Run \`npm install\` (or \`bun install\`) manually, then retry.`,
        'install_failed',
        { action: { cwd: appDir, argv: [detectPackageManager(appDir), 'install'] } },
      )
    }
    // `tail -f` isn't a Windows command — tailHint points PowerShell users at its equivalent.
    const tail = existsSync(logPath) ? ` Tail progress: ${tailHint(logPath)}.` : ''
    throw new Refusal(
      `Dependencies are still installing in the background.${tail} Retry once it finishes.`,
      'install_in_progress',
    )
  }

  throw new Refusal(
    'Dependencies not installed. Run `npm install` (or `bun install`) first.',
    'deps_missing',
    {
      action: { cwd: appDir, argv: [detectPackageManager(appDir), 'install'] },
    },
  )
}

/**
 * Ground truth for "dependencies ready", matching Node's resolver: walk up
 * from `fromDir` looking for node_modules/deepspace. A linked worktree inside
 * the app (e.g. `.deepspace/ws/<id>`) has no node_modules of its own, but its
 * imports resolve against the app checkout's — so the gate must walk up too,
 * or dev/deploy refuse in exactly the places tsc/vitest work.
 */
export function resolvesDeepspace(fromDir: string): boolean {
  let dir = fromDir
  for (;;) {
    if (existsSync(join(dir, 'node_modules', 'deepspace', 'package.json'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/**
 * Is the detached install worker still running? Missing or malformed identity
 * fails closed; a valid pid is alive when signal 0 succeeds. EPERM means
 * "alive, not ours".
 */
function installWorkerAlive(sentinelDir: string): boolean {
  const pidPath = join(sentinelDir, 'install.pid')
  if (!existsSync(pidPath)) return false
  const pid = Number(readFileSync(pidPath, 'utf-8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
