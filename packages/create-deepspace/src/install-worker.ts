/**
 * install-worker — runs detached after `create-deepspace` exits.
 *
 * Runs `npm/bun install` so the user gets their shell prompt back immediately.
 * The DeepSpace agent skill is installed synchronously by `create-deepspace`
 * itself (it doesn't need `node_modules`), so this worker only handles
 * dependencies. State is communicated back to the rest of the CLI via
 * sentinel files under `<appDir>/.deepspace/`:
 *
 *   install.started — written by the parent before spawning this worker
 *   install.log     — combined stdout/stderr of install
 *   install.done    — written on success
 *   install.err     — written on failure (contains the error message)
 *
 * Invocation (from create-deepspace):
 *   node dist/install-worker.js <appDir>
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [appDir] = process.argv.slice(2)
if (!appDir) {
  console.error('install-worker: missing appDir')
  process.exit(1)
}

const sentinelDir = join(appDir, '.deepspace')
mkdirSync(sentinelDir, { recursive: true })

function fail(msg: string): never {
  writeFileSync(join(sentinelDir, 'install.err'), msg.endsWith('\n') ? msg : msg + '\n')
  process.exit(1)
}

const hasBun = (() => {
  try {
    const r = spawnSync('bun', ['--version'], { stdio: 'pipe' })
    return r.status === 0
  } catch {
    return false
  }
})()

const installCmd = hasBun ? 'bun' : 'npm'
// bun caches package metadata persistently and silently fails to see versions
// published after the cache was warmed — `--force` refreshes metadata.
const installArgs = hasBun ? ['install', '--force'] : ['install', '--no-fund', '--no-audit']

const installResult = spawnSync(installCmd, installArgs, {
  cwd: appDir,
  stdio: 'inherit',
})
if (installResult.status !== 0) {
  fail(`${installCmd} ${installArgs.join(' ')} exited with code ${installResult.status}`)
}

writeFileSync(join(sentinelDir, 'install.done'), new Date().toISOString() + '\n')
