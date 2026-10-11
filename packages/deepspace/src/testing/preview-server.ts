/**
 * `servePreview` — the server browser tests run against when they need the
 * production build (an app whose web page is an Expo export, which only
 * `vite build` produces):
 *
 *   - builds the app with `vite build` and serves it with `vite preview`;
 *   - keeps its data in a fresh directory each run (`testState()` in the
 *     app's vite config reads it), so tests never touch real local data;
 *   - optionally makes a test account the app owner, so owner-only paths
 *     (the owner's store, owner tools) are covered.
 *
 * ```js
 * // tests/serve.mjs, run by Playwright's webServer
 * import { servePreview } from 'deepspace/testing'
 * servePreview({ appDir: new URL('..', import.meta.url), port: process.argv[2], owner: 'Tasks Tester' })
 * ```
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_STATE_DIR_ENV } from '../build/test-state'
import { findTestAccountByName } from './accounts'

export interface ServePreviewOptions {
  appDir: string | URL
  port: string | number
  /** A test account's name; it becomes OWNER_USER_ID for this run. */
  owner?: string
  /** Skip `vite build` and serve the existing dist/. Default false. */
  skipBuild?: boolean
}

/** The built Worker's directory: the one dist/ entry with a wrangler.json. */
export function builtWorkerDir(appDir: string): string {
  const dist = join(appDir, 'dist')
  const dir = existsSync(dist)
    ? readdirSync(dist, { withFileTypes: true }).find(
        (entry) => entry.isDirectory() && existsSync(join(dist, entry.name, 'wrangler.json')),
      )
    : undefined
  if (!dir) throw new Error(`servePreview: no built Worker in ${dist}; did \`vite build\` run?`)
  return join(dist, dir.name)
}

/** .dev.vars with OWNER_USER_ID replaced when an owner is given. */
export function previewVars(devVars: string, ownerUserId?: string): string {
  const lines = devVars.split('\n').filter((line) => line !== '')
  if (!ownerUserId) return `${lines.join('\n')}\n`
  return `${lines.filter((line) => !line.startsWith('OWNER_USER_ID=')).concat(`OWNER_USER_ID=${ownerUserId}`).join('\n')}\n`
}

export function servePreview(options: ServePreviewOptions): ChildProcess {
  const appDir = typeof options.appDir === 'string' ? options.appDir : fileURLToPath(options.appDir)
  const devVars = join(appDir, '.dev.vars')
  if (!existsSync(devVars)) {
    throw new Error('servePreview: no .dev.vars. Run `npx deepspace dev start` once to write it, then stop it.')
  }
  const ownerUserId = options.owner ? findTestAccountByName(options.owner).userId : undefined
  if (options.owner && !ownerUserId) {
    throw new Error(`servePreview: test account "${options.owner}" has no user id; sign it in once with \`deepspace test accounts\`.`)
  }

  if (!options.skipBuild) execFileSync('npx', ['vite', 'build'], { cwd: appDir, stdio: 'inherit' })
  // The build drops .dev.vars from its output (deploys must not carry it);
  // preview needs the platform URLs and keys.
  writeFileSync(join(builtWorkerDir(appDir), '.dev.vars'), previewVars(readFileSync(devVars, 'utf8'), ownerUserId), {
    mode: 0o600,
  })

  const state = mkdtempSync(join(tmpdir(), 'deepspace-test-state-'))
  const server = spawn('npx', ['vite', 'preview', '--port', String(options.port), '--strictPort', '--host', 'localhost'], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, [TEST_STATE_DIR_ENV]: state },
  })
  const stop = () => server.kill('SIGTERM')
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  server.on('exit', (code) => process.exit(code ?? 0))
  return server
}
