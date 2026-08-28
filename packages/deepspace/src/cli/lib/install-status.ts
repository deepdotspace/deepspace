import { Refusal } from './command'
/**
 * Verifies the app's dependencies are installed before running a command that
 * needs them (dev, test, deploy, add) — and HEALS the plain-missing state by
 * installing on first use (a fresh clone needs no manual `npm install`, the
 * way an id-less checkout needs no manual `app init`). A failed or still-
 * running install keeps its refusal.
 *
 * `create-deepspace` completes installation before returning and before its
 * initial commit. Sentinels under `<appDir>/.deepspace/` are how a run that
 * did NOT complete is told apart from one still in progress:
 *
 *   install.started — created before the package manager is spawned
 *   install.done    — written on successful completion
 *   install.err     — written on failure (contains the error message)
 *   install.log     — combined stdout/stderr, quoted in the refusal
 *
 * "Still installing" is age alone: install.started without install.done,
 * younger than the 6-minute bound. Live installers keep or fit the mtime
 * inside it — this module's heal times its spawn out at 5 minutes, and the
 * scaffolder (which has no hard timeout — a cold cache on a slow link is
 * legitimate) refreshes the mtime while its child runs, bounded at 30
 * minutes so a hung package manager cannot hold the refusal forever. The
 * old install.pid liveness protocol is gone: every part of it was a solved
 * bug — our own pid needed exempting (an earlier interrupted attempt), a
 * recycled pid false-positived (containers recycle from 1), and a zombie
 * pid answered `kill 0` as alive forever (v0.27.0 r1 AX BUG-2). A crashed
 * install heals on the first command after the age bound.
 *
 * "Ready" is `node_modules/deepspace/package.json` resolving AND no
 * interrupted-install evidence (`install.started` without `install.done`).
 * Resolution alone is not enough: npm writes that package.json long before it
 * links `node_modules/.bin`, so a KILLED install leaves a tree that resolves
 * but cannot run anything (`vitest: not found`, exit 127) — the sentinels are
 * the corroboration that the install actually finished. A tree installed by
 * hand has no sentinels and is ready on resolution alone.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { sync as spawnSync } from 'cross-spawn'
import { repoToplevel } from './git/repository'
import { detectPackageManager } from './package-manager'

export type InstallState = 'ready' | 'installing' | 'failed' | 'missing'

/** How long install.started's mtime may be trusted as "still installing":
 *  the heal's own spawn times out at 5 minutes, and the scaffolder's
 *  unbounded install refreshes the mtime while it runs. */
const INSTALLING_MAX_AGE_MS = 6 * 60 * 1000

/** install.started with no terminal sentinel (done = finished, err = failed;
 *  each installer removes err before a fresh attempt), young enough to be a
 *  live install. */
function installLikelyRunning(sentinelDir: string): boolean {
  const startedPath = join(sentinelDir, 'install.started')
  return (
    existsSync(startedPath) &&
    !existsSync(join(sentinelDir, 'install.done')) &&
    !existsSync(join(sentinelDir, 'install.err')) &&
    sentinelAgeMs(startedPath) < INSTALLING_MAX_AGE_MS
  )
}

/** `install.started` without `install.done`: an install began and never
 *  finished — the tree may RESOLVE (npm writes package.json early) while
 *  `.bin` was never linked, so this evidence overrides resolution. The
 *  counter-evidence is `.bin` itself: bin links are the LAST thing a package
 *  manager writes, so a populated `node_modules/.bin` means the install
 *  finished — by the heal, or by hand. Record `install.done` and stand down,
 *  or a hand-repaired tree (the DEEPSPACE_NO_INSTALL flow's own remedy)
 *  would loop on stale evidence forever: nothing but the heal ever wrote the
 *  done sentinel. */
function installInterrupted(appDir: string): boolean {
  const sentinelDir = join(appDir, '.deepspace')
  if (
    !existsSync(join(sentinelDir, 'install.started')) ||
    existsSync(join(sentinelDir, 'install.done'))
  ) {
    return false
  }
  try {
    if (readdirSync(join(appDir, 'node_modules', '.bin')).length > 0) {
      try {
        writeFileSync(join(sentinelDir, 'install.done'), new Date().toISOString())
      } catch {
        // Unwritable sentinel dir: the .bin evidence alone still answers.
      }
      return false
    }
  } catch {
    // No node_modules/.bin at all — genuinely incomplete.
  }
  return true
}

/** Non-throwing install state for informational surfaces such as status. */
export function installState(appDir: string): InstallState {
  if (resolvesDeepspace(appDir) && !installInterrupted(appDir)) return 'ready'
  const sentinelDir = join(appDir, '.deepspace')
  if (existsSync(join(sentinelDir, 'install.err'))) return 'failed'
  if (existsSync(join(sentinelDir, 'install.started'))) {
    return installLikelyRunning(sentinelDir) ? 'installing' : 'failed'
  }
  return 'missing'
}

/** How to watch the install log live, per platform: `tail -f` isn't on Windows
 *  (PowerShell's `Get-Content -Wait` is the equivalent). */
export function tailHint(logPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `Get-Content -Wait ${logPath}` : `tail -f ${logPath}`
}

export function ensureInstallReady(appDir: string): void {
  if (resolvesDeepspace(appDir) && !installInterrupted(appDir)) return

  const sentinelDir = join(appDir, '.deepspace')
  const logPath = join(sentinelDir, 'install.log')

  // Opt-out for callers who want to review before anything executes (an
  // install runs the packages' own lifecycle scripts): restore the old
  // refusal, same code and shape it always had.
  if (process.env.DEEPSPACE_NO_INSTALL) {
    // Two states land here: nothing installed, or a tree that RESOLVES but
    // carries interrupted-install evidence — say which, or the message
    // contradicts what the user can see on disk.
    const detail = resolvesDeepspace(appDir)
      ? 'A previous dependency install was interrupted (install.started without install.done)'
      : 'Dependencies not installed'
    throw new Refusal(
      `${detail}, and DEEPSPACE_NO_INSTALL is set — run the install yourself, then retry.`,
      'deps_missing',
      { action: { cwd: appDir, argv: [detectPackageManager(appDir), 'install'] } },
    )
  }

  // A concurrent live install (this command racing the scaffolder, or a
  // second command): wait-refuse rather than run a second package manager
  // into the same node_modules. Age is the only evidence — see the header
  // for why the pid liveness check is gone.
  if (installLikelyRunning(sentinelDir)) {
    const tail = existsSync(logPath) ? ` Tail progress: ${tailHint(logPath)}.` : ''
    throw new Refusal(
      `Dependencies are still installing.${tail} Retry once it finishes (or remove ${sentinelDir}/install.started if no install is actually running).`,
      'install_in_progress',
    )
  }

  // Everything else — plain missing, a previous attempt's install.err, an
  // interrupted install (started, no done, past the age bound) — is healed by trying
  // again NOW. A transient failure (registry blip, offline laptop) must not
  // permanently convert "installs on first use" back into a manual step;
  // each command invocation makes exactly one bounded attempt, so a
  // deterministic failure still fails loudly every time rather than looping.
  healMissingInstall(appDir)
}

/** One bounded foreground install, through the same sentinel protocol the
 *  scaffolder's installer writes, so a concurrent command sees `installing`
 *  and a crash mid-install reads as an interrupted attempt (retried on the
 *  next command) — never as "ready". Output STREAMS to install.log via a
 *  file descriptor: the log is tail-able during the install, and no pipe
 *  buffer cap can kill a chatty package manager mid-flight. */
function healMissingInstall(appDir: string): void {
  const manager = detectPackageManager(appDir)
  const sentinelDir = join(appDir, '.deepspace')
  const logPath = join(sentinelDir, 'install.log')
  const errPath = join(sentinelDir, 'install.err')
  const previousFailure = existsSync(errPath)
    ? readFileSync(errPath, 'utf-8').trimEnd()
    : null
  // stderr, always: `--json` stdout carries exactly one document, and a
  // silent multi-minute install reads as a hang without the log to watch.
  process.stderr.write(
    `Installing dependencies (${manager} install) — first use installs them. ` +
      `${previousFailure ? `Retrying after: ${previousFailure}. ` : ''}Watch: ${tailHint(logPath)}\n`,
  )
  // Windows resolves child binaries from the child's cwd FIRST: a cloned
  // repo shipping `npm.cmd` at its root would execute instead of the real
  // npm. Refuse rather than resolve — a repo carrying a file named after a
  // package manager at its root is not something to run an install in.
  if (process.platform === 'win32') {
    for (const ext of ['.cmd', '.bat', '.exe', '.com', '.ps1']) {
      if (existsSync(join(appDir, `${manager}${ext}`))) {
        throw new Refusal(
          `Refusing to install: ${appDir} contains ${manager}${ext}, which Windows would execute instead of the real ${manager}. Remove it, or run the install yourself from a shell you trust.`,
          'install_failed',
        )
      }
    }
  }
  mkdirSync(sentinelDir, { recursive: true })
  ensureSentinelsIgnored(appDir)
  rmSync(errPath, { force: true })
  rmSync(join(sentinelDir, 'install.done'), { force: true })
  // Older versions wrote an install.pid; clear the leftover so nothing on
  // disk suggests the deleted liveness protocol is still in force.
  rmSync(join(sentinelDir, 'install.pid'), { force: true })
  writeFileSync(join(sentinelDir, 'install.started'), new Date().toISOString())
  const logFd = openSync(logPath, 'w')
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(manager, ['install'], {
      cwd: appDir,
      stdio: ['ignore', logFd, logFd],
      // Bounded (repo rule: no task over 5 minutes): a hung registry must
      // surface as a fast failure, never a stall. The log names the cure.
      timeout: 5 * 60 * 1000,
    })
  } finally {
    closeSync(logFd)
  }
  if (result.status === 0 && !result.error && resolvesDeepspace(appDir)) {
    writeFileSync(join(sentinelDir, 'install.done'), new Date().toISOString())
    return
  }
  const detail = result.error
    ? (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      ? `${manager} install timed out after 5 minutes`
      : result.error.message
    : result.status === 0
      ? `${manager} install completed but the \`deepspace\` package still does not resolve — is this directory the app (its package.json must depend on deepspace)?`
      : result.status === null
        ? `${manager} install was killed (${result.signal ?? 'signal'})`
        : `${manager} install exited ${result.status}`
  writeFileSync(errPath, detail)
  // The tail rides in the refusal itself: in CI the runner (and its log
  // file) is destroyed with the job, so a path alone explains nothing.
  let logTail = ''
  try {
    const log = readFileSync(logPath, 'utf-8')
    const tail = log.slice(-1500).trimEnd()
    if (tail) logTail = `\n--- install log (tail) ---\n${tail}`
  } catch {
    // No log to quote.
  }
  throw new Refusal(
    `Dependency install failed: ${detail}. Full log: ${logPath}. It will be retried on the next command, or run \`${manager} install\` yourself.${logTail}`,
    'install_failed',
    { action: { cwd: appDir, argv: [manager, 'install'] } },
  )
}

/** Age of a sentinel file in ms; Infinity when unreadable (treat as stale). */
function sentinelAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Keep the heal's own sentinels out of the user's working tree. Scaffolds
 * ship `.deepspace` in .gitignore; a hand-built or GitHub-sourced app may
 * not, and then the sentinels the heal writes would trip deploy's
 * dirty-worktree refusal, push's uncommitted warning, and the release's
 * dirty flag — all self-inflicted. `.git/info/exclude` is the repo-LOCAL
 * ignore file (never committed, never the user's .gitignore), which makes it
 * the one place this tool may write an ignore rule.
 */
function ensureSentinelsIgnored(appDir: string): void {
  try {
    const check = spawnSync('git', ['-C', appDir, 'check-ignore', '-q', '.deepspace'], {
      stdio: 'ignore',
    })
    if (check.status === 0 || check.error) return // already ignored, or no git
    const excludePath = spawnSync('git', ['-C', appDir, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf-8',
    })
    if (excludePath.status !== 0) return
    const target = resolve(appDir, excludePath.stdout.trim())
    mkdirSync(dirname(target), { recursive: true })
    appendFileSync(target, '\n# deepspace CLI state (added by first-use install)\n.deepspace/\n')
  } catch {
    // Best-effort: an unwritable .git must never block the install.
  }
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

/** Is a process with this pid alive? Signal 0 probes without delivering;
 *  EPERM means "alive, not ours". Used by the deploy lock's pid sentinel. */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
