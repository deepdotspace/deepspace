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
 * The package-install command to run: bun when present, else npm. bun caches
 * package metadata persistently and silently misses versions published after
 * the cache warmed, so `--force` refreshes it; npm gets the quiet flags.
 * `npm`/`bun` is `npm.cmd`/`bun.exe` on Windows — the caller MUST spawn this
 * through cross-spawn, which a plain child_process spawn of a `.cmd` cannot do.
 */
export function resolveInstall(hasBun: boolean): { cmd: string; args: string[] } {
  return hasBun
    ? { cmd: 'bun', args: ['install', '--force'] }
    : { cmd: 'npm', args: ['install', '--no-fund', '--no-audit'] }
}
