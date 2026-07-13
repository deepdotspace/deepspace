import { execSync } from 'node:child_process'
import { sync as spawnSync } from 'cross-spawn'

export function ensurePlaywright(appDir: string) {
  try {
    // execSync interprets the command via shell, so it handles npx/npx.cmd
    // resolution on its own. Only spawn()/spawnSync() need cross-spawn.
    execSync('npx playwright --version', { cwd: appDir, stdio: 'pipe' })
  } catch {
    console.log('Installing Playwright...')
    execSync('npm install -D @playwright/test', { cwd: appDir, stdio: 'pipe' })
  }

  // `playwright install` is idempotent: a fast no-op when Chromium already
  // exists, and the first real browser download only when a browser command
  // actually needs it.
  const isLinux = process.platform === 'linux'
  const isRoot = isLinux && typeof process.getuid === 'function' && process.getuid() === 0
  const args = isRoot ? ['install', '--with-deps', 'chromium'] : ['install', 'chromium']
  const result = spawnSync('npx', ['playwright', ...args], {
    cwd: appDir,
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    console.error('\nPlaywright install failed. On Linux, system libs may be missing. Try:')
    console.error('  sudo npx playwright install --with-deps chromium')
    process.exit(1)
  }
}
