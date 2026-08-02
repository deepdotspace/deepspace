/**
 * install-worker — runs `npm/bun install` for a freshly scaffolded app.
 *
 * On POSIX `create-deepspace` spawns this DETACHED so the user gets their shell
 * back immediately. On Windows the scaffolder installs in the FOREGROUND
 * instead and does not use this worker: a detached child can't be guaranteed to
 * outlive `npm create`/`npx` there (the terminal places the process tree in a
 * job object and Node can't set CREATE_BREAKAWAY_FROM_JOB), which leaves a
 * half-installed app with no error trace.
 *
 * Self-sufficient by design: it is handed the LOG PATH (not an inherited fd)
 * and opens/owns the log itself, so the file handle's lifetime is the worker's
 * and never depends on the parent still being alive. State is reported via
 * sentinel files under `<appDir>/.deepspace/`:
 *
 *   install.log  — combined stdout/stderr of the install (opened here)
 *   install.done — written on success
 *   install.err  — written on failure (contains the error message)
 *
 * Invocation:  node install-worker.js <appDir> <logPath>
 */
import { sync as spawnSync } from 'cross-spawn'
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectBun, resolveInstall } from './install-cmd'

/**
 * Run the dependency install and write the completion/failure sentinel.
 * Returns the process exit code (0 = done). Exported so the behavior is
 * unit-testable without spawning a detached process.
 */
export function runInstall(appDir: string, logPath: string): number {
  const sentinelDir = join(appDir, '.deepspace')
  mkdirSync(sentinelDir, { recursive: true })

  const fail = (msg: string): number => {
    writeFileSync(join(sentinelDir, 'install.err'), msg.endsWith('\n') ? msg : msg + '\n')
    return 1
  }

  // Open (append) the log HERE so the worker owns the fd — it must survive the
  // parent exiting on the detached path. `npm`/`bun` resolves to `npm.cmd` /
  // `bun.exe` on Windows; cross-spawn execs the shim that a plain spawnSync of
  // a `.cmd` refuses (ENOENT / EINVAL since Node's CVE-2024-27980 hardening).
  const logFd = openSync(logPath, 'a')
  try {
    const { cmd, args } = resolveInstall(detectBun())
    const res = spawnSync(cmd, args, { cwd: appDir, stdio: ['ignore', logFd, logFd] })
    if (res.error) return fail(`${cmd} ${args.join(' ')} failed to start: ${res.error.message}`)
    if (res.status !== 0) return fail(`${cmd} ${args.join(' ')} exited with code ${res.status}`)
  } finally {
    closeSync(logFd)
  }

  writeFileSync(join(sentinelDir, 'install.done'), new Date().toISOString() + '\n')
  return 0
}

// Run only when invoked as the process entry (node install-worker.js …), not
// when imported by a test — otherwise importing this module would trigger a
// real install.
const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const [appDir, logPath] = process.argv.slice(2)
  if (!appDir) {
    console.error('install-worker: missing appDir')
    process.exit(1)
  }
  process.exit(runInstall(appDir, logPath || join(appDir, '.deepspace', 'install.log')))
}
