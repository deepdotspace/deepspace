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
import { join } from 'node:path'

export function ensureInstallReady(appDir: string): void {
  if (existsSync(join(appDir, 'node_modules', 'deepspace', 'package.json'))) return

  const sentinelDir = join(appDir, '.deepspace')
  const errPath = join(sentinelDir, 'install.err')
  const startedPath = join(sentinelDir, 'install.started')
  const donePath = join(sentinelDir, 'install.done')
  const logPath = join(sentinelDir, 'install.log')

  if (existsSync(errPath)) {
    console.error('Background install failed:')
    console.error(readFileSync(errPath, 'utf-8').trimEnd())
    if (existsSync(logPath)) console.error(`\nFull log: ${logPath}`)
    console.error('\nRun `npm install` (or `bun install`) manually, then retry.')
    process.exit(1)
  }

  if (existsSync(startedPath) && !existsSync(donePath)) {
    // A worker that died without writing done/err (OOM, docker stop, laptop
    // shutdown) must not read as "still installing" forever. install.pid is
    // written by create-deepspace ≥0.5.6; without it, assume in-progress.
    if (!installWorkerAlive(sentinelDir)) {
      console.error('The background install is no longer running and never finished.')
      if (existsSync(logPath)) console.error(`See what happened: ${logPath}`)
      console.error('Run `npm install` (or `bun install`) manually, then retry.')
      process.exit(1)
    }
    console.error('Dependencies are still installing in the background.')
    if (existsSync(logPath)) console.error(`Tail progress: tail -f ${logPath}`)
    console.error('Retry once it finishes.')
    process.exit(1)
  }

  console.error('Dependencies not installed. Run `npm install` (or `bun install`) first.')
  process.exit(1)
}

/**
 * Is the detached install worker still running? True when install.pid is
 * missing (pre-0.5.6 scaffolds — assume in-progress rather than cry wolf) or
 * the pid answers signal 0. EPERM means "alive, not ours".
 */
function installWorkerAlive(sentinelDir: string): boolean {
  const pidPath = join(sentinelDir, 'install.pid')
  if (!existsSync(pidPath)) return true
  const pid = Number.parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
