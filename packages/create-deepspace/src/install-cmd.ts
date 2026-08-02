/**
 * Shared install-command resolution for the scaffolder and its background
 * worker, so the foreground (Windows) and detached (POSIX) install paths agree
 * on exactly what gets run. Kept side-effect-free apart from `detectBun`, which
 * probes for the binary.
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

/** How to watch the install log live, per platform: `tail -f` isn't a Windows
 *  command (PowerShell's `Get-Content -Wait` is the equivalent). */
export function tailHint(logPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `Get-Content -Wait ${logPath}` : `tail -f ${logPath}`
}
