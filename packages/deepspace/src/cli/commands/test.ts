/**
 * deepspace test [suite] [--port N]
 *
 * Runs tests for a DeepSpace app. Always uses dev workers.
 *
 *   deepspace test              # smoke + api (quick check)
 *   deepspace test smoke        # smoke tests only
 *   deepspace test api          # API tests only
 *   deepspace test e2e          # all Playwright tests
 *   deepspace test unit         # vitest unit tests
 *   deepspace test all          # everything
 *   deepspace test <file>       # run specific test file
 *
 * Port is `--port` > $DEEPSPACE_PORT > 5173 — except inside a Claude Code
 * worktree, where (unless --port was passed) the worktree's own port is used
 * so tests hit the worktree's server, not the main repo's. The chosen port is
 * exported as DEEPSPACE_PORT to the Playwright child so the config +
 * webServer both bind to the same address. Pass a different port per app to
 * run multiple apps
 * (and test suites) in parallel.
 */

import { defineCommand } from 'citty'
import { readAppId } from '../lib/app-identity'
import { resolve } from 'node:path'
import { sync as spawnSync } from 'cross-spawn'
import { ensureToken } from '../auth'
import { findAppDir, findChildApps, resolveWorktreePort } from '../lib/app-context'
import { PLATFORM_URLS, writeDevVars } from '../env'
import { decodeJwtPayload } from '../jwt'
import { ensureInstallReady } from '../lib/install-status'
import { ensurePlaywright } from '../lib/playwright'
import { preflightNodeVersion, preflightWindowsWorkerd } from '../lib/preflight'
import { refreshSecretsCache } from '../lib/secrets'
import { DEFAULT_PORT, resolvePort } from '../lib/port'
import {
  prepareWranglerEnvConfig,
  wranglerViteEnv,
  type PreparedWranglerEnvConfig,
} from '../lib/wrangler-env'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineCommand({
  meta: {
    name: 'test',
    description: 'Run tests for your DeepSpace app',
  },
  args: {
    suite: {
      type: 'positional',
      description: 'Test suite: smoke, api, e2e, unit, all (default: smoke+api)',
      required: false,
    },
    port: {
      type: 'string',
      description: `Port for vite/webServer (default ${DEFAULT_PORT}, or $DEEPSPACE_PORT)`,
      required: false,
    },
    env: {
      type: 'string',
      alias: 'e',
      description:
        'wrangler.toml [env.<name>] block to test (uses secrets config <name> by default).',
      required: false,
    },
  },
  async run({ args }) {
    preflightNodeVersion('test')
    const suite = args.suite ?? 'default'
    const wranglerEnv =
      typeof args.env === 'string' && args.env.trim() ? args.env.trim() : undefined

    // Resolve the app root by walking up from cwd, matching `deepspace dev`.
    const start = resolve('.')
    const appDir = findAppDir(start)
    if (!appDir) {
      console.error(`No wrangler.toml found at or above ${start}.`)
      const children = findChildApps(start)
      if (children.length > 0) {
        console.error('Did you mean to run inside one of these app directories?')
        for (const c of children) console.error(`  cd ${c}`)
      } else {
        console.error('Run from a DeepSpace app directory (one containing wrangler.toml).')
      }
      process.exit(1)
    }

    // Inside a Claude Code worktree the default port must match the
    // worktree's dev server (not 5173): Playwright's reuseExistingServer
    // would otherwise attach to the MAIN repo's server and silently test
    // stale code. Explicit --port still wins.
    const worktreePort = args.port ? null : resolveWorktreePort(appDir)
    const port = worktreePort ?? resolvePort(args.port)
    if (worktreePort && process.env.DEEPSPACE_PORT) {
      console.log(
        `Ignoring DEEPSPACE_PORT=${process.env.DEEPSPACE_PORT} inside a worktree — ` +
          `targeting per-worktree port ${port}. Pass --port to override.`,
      )
    }

    ensureInstallReady(appDir)

    // Always write .dev.vars pointing to dev workers. A logged-in user is
    // required so writeDevVars can mint APP_OWNER_JWT via the auth-worker.
    let token: string
    let ownerId: string
    try {
      token = await ensureToken()
      const payload = decodeJwtPayload<{ sub: string }>(token)
      ownerId = payload.sub
    } catch (err) {
      // Surface ensureToken's canonical message ("Not logged in. Run `deepspace
      // login` first." / "Session expired…") instead of a bespoke one (ONB-5).
      console.error(err instanceof Error ? err.message : 'Not logged in. Run `deepspace login` first.')
      process.exit(1)
    }

    // Refresh the app-store secrets cache (config = wrangler env, or 'prd').
    // A repo without a DEEPSPACE_APP_ID hasn't been initialized — writeDevVars
    // below throws with the `deepspace init` pointer, so skip the pull.
    let generatedSecretsCache: string | undefined
    const appIdForSecrets = readAppId(appDir, wranglerEnv)
    if (appIdForSecrets) {
      try {
        const refreshed = await refreshSecretsCache(DEPLOY_URL, token, appIdForSecrets, wranglerEnv)
        if (refreshed) {
          generatedSecretsCache = refreshed.rendered
          console.log(refreshed.summary)
        }
      } catch (err: unknown) {
        console.error(
          `Failed to refresh app secrets: ${err instanceof Error ? err.message : String(err)}`,
        )
        process.exit(1)
      }
    }

    const sharedDevVarsCache = generatedSecretsCache !== undefined
    await writeDevVars(appDir, ownerId, token, wranglerEnv, {
      generatedSecretsCache,
      sharedDevVarsCache,
    })

    if (suite !== 'unit') {
      preflightWindowsWorkerd(appDir)
      ensurePlaywright(appDir)
    }

    let exitCode = 0

    switch (suite) {
      case 'smoke':
        exitCode = runPlaywright(
          appDir,
          ['tests/smoke.spec.ts'],
          port,
          wranglerEnv,
          sharedDevVarsCache,
        )
        break
      case 'api':
        exitCode = runPlaywright(
          appDir,
          ['tests/api.spec.ts'],
          port,
          wranglerEnv,
          sharedDevVarsCache,
        )
        break
      case 'e2e':
        exitCode = runPlaywright(appDir, [], port, wranglerEnv, sharedDevVarsCache)
        break
      case 'unit':
        exitCode = runVitest(appDir)
        break
      case 'all':
        exitCode = runVitest(appDir)
        if (exitCode === 0)
          exitCode = runPlaywright(appDir, [], port, wranglerEnv, sharedDevVarsCache)
        break
      case 'default':
        exitCode = runPlaywright(
          appDir,
          ['tests/smoke.spec.ts', 'tests/api.spec.ts'],
          port,
          wranglerEnv,
          sharedDevVarsCache,
        )
        break
      default:
        if (suite.endsWith('.spec.ts')) {
          exitCode = runPlaywright(appDir, [suite], port, wranglerEnv, sharedDevVarsCache)
        } else {
          console.error(`Unknown test suite: ${suite}`)
          console.error('Available: smoke, api, e2e, unit, all')
          process.exit(1)
        }
    }

    process.exit(exitCode)
  },
})

function runPlaywright(
  appDir: string,
  testFiles: string[],
  port: number,
  wranglerEnv?: string,
  sharedDevVarsCache = false,
): number {
  let wranglerConfig: PreparedWranglerEnvConfig
  try {
    wranglerConfig = prepareWranglerEnvConfig(appDir, wranglerEnv, { sharedDevVarsCache })
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
  try {
    const result = spawnSync(
      'npx',
      ['playwright', 'test', '--config', 'tests/playwright.config.ts', ...testFiles],
      {
        cwd: appDir,
        stdio: 'inherit',
        env: wranglerViteEnv(process.env, wranglerConfig, { DEEPSPACE_PORT: String(port) }),
      },
    )
    return result.status ?? 1
  } finally {
    wranglerConfig.cleanup()
  }
}

function runVitest(appDir: string): number {
  const result = spawnSync('npx', ['vitest', 'run', '--passWithNoTests'], {
    cwd: appDir,
    stdio: 'inherit',
  })
  return result.status ?? 1
}
