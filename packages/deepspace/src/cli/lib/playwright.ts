import { Refusal } from './command'
import { execSync, type StdioOptions } from 'node:child_process'
import { sync as spawnSync } from 'cross-spawn'

/**
 * `--json` reserves stdout for the single envelope line, so every child a test
 * run spawns writes ITS stdout to our stderr instead — the live feedback stays
 * visible and stdout stays parseable.
 *
 * One flag, set once by the command body, read at every spawn. Routing only the
 * suite runner left the dependency preflight below emitting `Installing
 * dependencies...` plus a full apt transcript on stdout, so
 * `deepspace test run --json | jq` failed on Linux on every run — the exact
 * environment the flag exists for.
 */
let childStdoutToStderr = false

export function routeChildStdoutToStderr(enabled: boolean): void {
  childStdoutToStderr = enabled
}

/** Stdio for a child whose output is progress, not result. */
export function childStdio(): StdioOptions {
  return childStdoutToStderr ? ['inherit', 2, 2] : 'inherit'
}

export function ensurePlaywright(appDir: string) {
  try {
    // execSync interprets the command via shell, so it handles npx/npx.cmd
    // resolution on its own. Only spawn()/spawnSync() need cross-spawn.
    execSync('npx playwright --version', { cwd: appDir, stdio: 'pipe' })
  } catch {
    // Progress notices go to stderr on every path: they are not this command's
    // result, and stdout may be carrying a JSON envelope.
    console.error('Installing Playwright...')
    execSync('npm install -D @playwright/test', { cwd: appDir, stdio: 'pipe' })
  }

  // `playwright install` is idempotent: a fast no-op when Chromium already
  // exists, and the first real browser download only when a browser command
  // actually needs it.
  const isLinux = process.platform === 'linux'
  const isRoot = isLinux && typeof process.getuid === 'function' && process.getuid() === 0
  const args = isRoot ? ['install', '--with-deps', 'chromium'] : ['install', 'chromium']
  if (isRoot) {
    // Say what is about to happen before the apt transcript starts: this step
    // installs system packages as root, and on a cold container it is minutes
    // of output, not a hang.
    console.error(
      'Installing Chromium and its system libraries — this runs `apt-get` as root and can take several minutes on a cold machine.',
    )
  }
  const result = spawnSync('npx', ['playwright', ...args], {
    cwd: appDir,
    stdio: childStdio(),
  })

  if (result.status !== 0) {
    throw new Refusal(
      'Playwright install failed. On Linux, system libs may be missing. Try: sudo npx playwright install --with-deps chromium',
      'playwright_install_failed',
    )
  }
}
