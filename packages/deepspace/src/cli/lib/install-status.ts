import { Refusal } from './command'
/**
 * Verifies the app's dependencies are installed before running a command that
 * needs them (dev, test, deploy, add).
 *
 * Current `create-deepspace` completes installation before returning and
 * before its initial commit. Sentinels under `<appDir>/.deepspace/` retain
 * compatibility with scaffolds created by the older detached installer:
 *
 *   install.started — created before the worker is spawned
 *   install.pid     — legacy worker pid (liveness check for an older scaffold)
 *   install.done    — written on successful completion
 *   install.err     — written on failure (contains the error message)
 *   install.log     — legacy combined stdout/stderr
 *
 * The presence of `node_modules/deepspace/package.json` is the ground truth
 * for "ready"; the sentinels only shape the error message.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { repoToplevel } from './git/repository'
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
      `Dependency install failed: ${detail}.${log} Run \`npm install\` (or \`bun install\`) manually, then retry.`,
      'install_failed',
      { action: { cwd: appDir, argv: [detectPackageManager(appDir), 'install'] } },
    )
  }

  if (existsSync(startedPath) && !existsSync(donePath)) {
    // A worker that died without writing done/err (OOM, docker stop, laptop
    // shutdown) must not read as "still installing" forever. Every installer
    // generation writes a valid install.pid before starting package-manager work.
    if (!installWorkerAlive(sentinelDir)) {
      const log = existsSync(logPath) ? ` See what happened: ${logPath}.` : ''
      throw new Refusal(
        `The dependency install is no longer running and never finished.${log} Run \`npm install\` (or \`bun install\`) manually, then retry.`,
        'install_failed',
        { action: { cwd: appDir, argv: [detectPackageManager(appDir), 'install'] } },
      )
    }
    // `tail -f` isn't a Windows command — tailHint points PowerShell users at its equivalent.
    const tail = existsSync(logPath) ? ` Tail progress: ${tailHint(logPath)}.` : ''
    throw new Refusal(
      `Dependencies are still installing.${tail} Retry once it finishes.`,
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
 * Ground truth for "dependencies ready": walk up from `fromDir` looking for
 * node_modules/deepspace, but never cross the active Git checkout boundary.
 * This supports monorepo hoisting inside a checkout without letting a managed
 * worktree nested below the primary checkout silently use the primary's SDK.
 * Outside Git, retain Node's ordinary upward lookup.
 */
export function resolvesDeepspace(fromDir: string): boolean {
  let dir = canonicalPath(fromDir)
  let checkoutRoot: string | null = null
  try {
    checkoutRoot = canonicalPath(repoToplevel(dir))
  } catch {
    // Dev/test can still provide the legacy dependency diagnostic outside Git.
  }
  for (;;) {
    if (existsSync(join(dir, 'node_modules', 'deepspace', 'package.json'))) return true
    if (dir === checkoutRoot) return false
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
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
