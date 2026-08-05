/**
 * Shared install-command resolution for the scaffolder. Kept side-effect-free
 * apart from `detectBun`, which probes for the binary.
 */
import spawn from 'cross-spawn'

/** Is the `bun` binary available? cross-spawn so the probe resolves
 *  `bun`/`bun.exe` uniformly; a spawn error (ENOENT) means "no bun". */
export function detectBun(): boolean {
  try {
    return spawn.sync('bun', ['--version'], { stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
}

/**
 * The package-install command to run. The manager that invoked the scaffold
 * (`npm create`, `pnpm create`, `bunx`, …) owns the app's lockfile from day
 * one — a different manager here would leave two lockfiles and make the very
 * first `install` after scaffolding dirty the worktree. Only a direct binary
 * invocation (no user agent) falls back to bun-if-present. bun caches package
 * metadata persistently and silently misses versions published after the
 * cache warmed, so `--force` refreshes it; npm gets the quiet flags.
 * `npm`/`bun` is `npm.cmd`/`bun.exe` on Windows — the caller MUST spawn this
 * through cross-spawn, which a plain child_process spawn of a `.cmd` cannot do.
 */
export function resolveInstall(
  hasBun: boolean,
  userAgent: string | undefined,
): { cmd: string; args: string[] } {
  const bun = { cmd: 'bun', args: ['install', '--force'] }
  const npm = { cmd: 'npm', args: ['install', '--no-fund', '--no-audit'] }
  const manager = userAgent?.split('/', 1)[0]
  if (manager === 'bun') return bun
  if (manager === 'npm') return npm
  if (manager === 'pnpm') return { cmd: 'pnpm', args: ['install'] }
  if (manager === 'yarn') return { cmd: 'yarn', args: ['install'] }
  return hasBun ? bun : npm
}
