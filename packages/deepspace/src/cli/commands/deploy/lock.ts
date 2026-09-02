/**
 * The local deploy lock.
 *
 * Two deploys of one checkout race on its build output: the loser used to
 * die on a raw `ENOENT … dist/…/index.js` under `deploy_failed`, while the
 * winner shipped — and the loser's agent then debugged its build. The
 * platform's own `release_in_progress` lock engages only after the build, so
 * the checkout needs one of its own. `O_EXCL` (`flag: 'wx'`) creates the file
 * atomically.
 *
 * A stale lock is reclaimed at acquire time (AX C1, docs/audits/2026-09-01:
 * a SIGINT-killed deploy orphaned the lock and the old refusal prescribed a
 * ten-minute stall for a provably dead holder). "Stale" is judged the same
 * way install-status.ts judges its sentinel: the holder pid reads DEAD
 * (kill-0 never reports a live process dead; only zombies read falsely
 * alive), or the lock FILE is older than any real deploy (mtime — the
 * zombie-proof signal). Reclaim stays race-safe because the `wx` create is
 * retried once: two reclaimers can both remove the stale file, but only one
 * wins the recreate, and the loser refuses on the winner's fresh record.
 * A SIGINT/SIGTERM during a locked deploy now releases the lock, says so on
 * stderr, and exits through `process.exit` so the `--json` crash envelope
 * still prints.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Refusal } from '../../lib/command'
import { processAlive } from '../../lib/install-status'

/** No deploy runs this long; an older lock file is a dead deploy's residue. */
export const DEPLOY_LOCK_MAX_AGE_MS = 10 * 60_000

interface DeployLockRecord {
  pid: number
  startedAt: string
  token: string
}

export function deployLockPath(appDir: string): string {
  return join(appDir, '.deepspace', 'deploy.lock')
}

/** Take the lock or refuse `deploy_in_progress`; returns the release function. */
export function acquireDeployLock(appDir: string): () => void {
  const path = deployLockPath(appDir)
  mkdirSync(dirname(path), { recursive: true })
  const record: DeployLockRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  }
  const take = (): boolean => {
    try {
      writeFileSync(path, JSON.stringify(record), { flag: 'wx' })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      return false
    }
  }
  if (!take()) {
    if (lockIsStale(path)) rmSync(path, { force: true })
    if (!take()) {
      const holder = readLock(path)
      throw new Refusal(
        (holder
          ? `Another deploy of this directory holds the deploy lock (pid ${holder.pid}, started ${holder.startedAt})`
          : `A fresh deploy lock is present at ${path} but unreadable, so this run cannot tell whether a deploy is live`) +
          ' — two deploys of one checkout race on its build output. Dead and stale locks are ' +
          'reclaimed automatically, so this holder still looks live; wait for it to finish, or ' +
          `remove ${path} and retry only if you are certain no deploy is running.`,
        'deploy_in_progress',
        {
          extra: {
            lockPath: path,
            ...(holder ? { holder: { pid: holder.pid, startedAt: holder.startedAt } } : {}),
          },
        },
      )
    }
  }

  // An interrupt must not orphan the lock or die silently: release, say so,
  // and leave through `process.exit` so registered 'exit' handlers (the
  // deploy --json crash envelope among them) still run.
  const onSignal = (signal: NodeJS.Signals): void => {
    release()
    process.stderr.write(`Deploy interrupted by ${signal}; released the deploy lock.\n`)
    process.exit(signal === 'SIGTERM' ? 143 : 130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  function release(): void {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    // A lock can be removed manually and replaced before an old deploy winds
    // down. The old release callback owns only its nonce, never the pathname.
    if (readLock(path)?.token === record.token) rmSync(path, { force: true })
  }
  return release
}

/** True when the lock's holder is provably dead or the file has outlived any
 *  real deploy. An unreadable-but-young lock is NOT stale: it may be a
 *  concurrent writer mid-create. */
function lockIsStale(path: string): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs > DEPLOY_LOCK_MAX_AGE_MS) return true
  } catch {
    return false // vanished — the next `wx` attempt settles it
  }
  const holder = readLock(path)
  return holder !== null && !processAlive(holder.pid)
}

/** The lock's record, or `null` when the file is unreadable or not a record. */
function readLock(path: string): DeployLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DeployLockRecord>
    return typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.token === 'string'
      ? { pid: parsed.pid, startedAt: parsed.startedAt, token: parsed.token }
      : null
  } catch {
    return null
  }
}
