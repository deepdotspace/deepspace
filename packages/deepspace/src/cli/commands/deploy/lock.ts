/**
 * The local deploy lock.
 *
 * Two deploys of one checkout race on its build output: the loser used to
 * die on a raw `ENOENT … dist/…/index.js` under `deploy_failed`, while the
 * winner shipped — and the loser's agent then debugged its build. The
 * platform's own `release_in_progress` lock engages only after the build, so
 * the checkout needs one of its own. `O_EXCL` (`flag: 'wx'`) creates the file
 * atomically. Existing locks are never reclaimed automatically: deciding a
 * holder is dead and deleting by pathname races another acquirer.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Refusal } from '../../lib/command'

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
  try {
    writeFileSync(path, JSON.stringify(record), { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const holder = readLock(path)
    throw new Refusal(
      (holder
        ? `Another deploy of this directory holds the deploy lock (pid ${holder.pid}, started ${holder.startedAt})`
        : `A deploy lock is present at ${path} but unreadable, so this run cannot tell whether a deploy is live`) +
        ' — two deploys of one checkout race on its build output. Judge liveness by the ' +
        'START TIME, not the pid: no deploy runs longer than a few minutes, so a lock older ' +
        'than ~10 minutes is a dead deploy (in containers the pid can read as alive — a ' +
        `reaped child leaves a zombie \`ps\` still reports). Then remove ${path} and retry.`,
      'deploy_in_progress',
      {
        extra: {
          lockPath: path,
          ...(holder ? { holder: { pid: holder.pid, startedAt: holder.startedAt } } : {}),
        },
      },
    )
  }
  return () => {
    // A lock can be removed manually and replaced before an old deploy winds
    // down. The old release callback owns only its nonce, never the pathname.
    if (readLock(path)?.token === record.token) rmSync(path, { force: true })
  }
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
