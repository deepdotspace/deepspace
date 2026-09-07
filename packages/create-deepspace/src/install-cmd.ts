/**
 * Package-manager selection and compatibility checks for the scaffolder.
 */
import spawn from 'cross-spawn'
import { satisfies } from 'semver'

export interface InstallCommand {
  cmd: string
  args: string[]
  display: string
}

/** Keep nested npm commands on the npm selected by the caller, not PATH's npm. */
export function npmCommand(
  args: string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { command: string; args: string[] } {
  const npmExecPath = environment.npm_execpath
  return npmExecPath && /(?:^|[/\\])npm-cli\.(?:c?js|mjs)$/i.test(npmExecPath)
    ? { command: process.execPath, args: [npmExecPath, ...args] }
    : { command: 'npm', args }
}

/** Resolve and check once, before copying files, then execute this exact command. */
export function checkedInstallCommand(
  npmRange: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { ok: true; install: InstallCommand } | { ok: false; error: string } {
  const userAgent = environment.npm_config_user_agent
  const manager = userAgent?.split('/', 1)[0]
  const hasBun = !['npm', 'pnpm', 'yarn', 'bun'].includes(manager ?? '') && detectBun()
  const selected = resolveInstall(hasBun, userAgent)
  const display = `${selected.cmd} ${selected.args.join(' ')}`
  if (selected.cmd !== 'npm') {
    return { ok: true, install: { ...selected, display } }
  }

  const probe = npmCommand(['--version'], environment)
  const result = spawn.sync(probe.command, probe.args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10_000,
  })
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error:
        'create-deepspace could not determine the npm version. Check that `npm --version` succeeds, ' +
        'then retry; no project files were changed.',
    }
  }
  const version = result.stdout.trim()
  if (!satisfies(version, npmRange)) {
    return {
      ok: false,
      error:
        `create-deepspace requires npm ${npmRange} (current: ${version || 'unknown'}). ` +
        "Older npm versions can crash while resolving the template's peer dependencies. " +
        'Update npm (`npm install --global npm@11`) and rerun the same scaffold command, ' +
        'or use `pnpm create deepspace@latest`. No project files were changed.',
    }
  }
  const installer = npmCommand(selected.args, environment)
  return { ok: true, install: { cmd: installer.command, args: installer.args, display } }
}

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
