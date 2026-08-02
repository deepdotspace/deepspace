/**
 * deepspace test run [suite] [--port N]
 *
 * Runs tests for a DeepSpace app. Always uses dev workers.
 *
 *   deepspace test run              # smoke + api (quick check)
 *   deepspace test run smoke        # smoke tests only
 *   deepspace test run api          # API tests only
 *   deepspace test run e2e          # all Playwright tests
 *   deepspace test run unit         # vitest unit tests
 *   deepspace test run all          # everything
 *   deepspace test run <file>       # run specific test file
 *
 * Port is `--port` > $DEEPSPACE_PORT > 5173 — except inside a Claude Code
 * worktree, where (unless --port was passed) the worktree's own port is used
 * so tests hit the worktree's server, not the main repo's. The chosen port is
 * exported as DEEPSPACE_PORT to the Playwright child so the config +
 * webServer both bind to the same address. Pass a different port per app to
 * run multiple apps
 * (and test suites) in parallel.
 *
 * Defined with the command runtime (lib/command.ts). The suite runner streams
 * playwright/vitest output through inherited stdio, so under `--json` that
 * text still scrolls past and the envelope is the LAST line rather than the
 * only one — buffering a test run to keep stdout pristine would cost the live
 * feedback the command exists for. The suite's own exit code collapses to the
 * contract's 0/1.
 */

import { readAppId } from '../lib/app-identity'
import { resolve } from 'node:path'
import { sync as spawnSync } from 'cross-spawn'
import { ensureToken } from '../auth'
import { findAppDir, findChildApps } from '../lib/app-context'
import { resolveWorktreePort } from '../lib/launch-config'
import { PLATFORM_URLS } from '../env'
import { writeDevVars } from '../lib/dev-vars'
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
import { cliAction, defineDeepspaceCommand, Refusal } from '../lib/command'
// Same refusal text `dev` uses — one source so the two can't drift.
import { noAppDirMessage } from './dev'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy

export default defineDeepspaceCommand({
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
    const say = (line: string) => {
      if (!args.json) console.log(line)
    }
    preflightNodeVersion('test run')
    const suite = (args.suite as string | undefined) ?? 'default'
    const wranglerEnv =
      typeof args.env === 'string' && args.env.trim() ? args.env.trim() : undefined

    // Resolve the app root by walking up from cwd, matching `deepspace dev start`.
    const start = resolve('.')
    const appDir = findAppDir(start)
    if (!appDir) {
      throw new Refusal(noAppDirMessage(start, findChildApps(start)), 'no_app_dir')
    }

    // Inside a Claude Code worktree the default port must match the
    // worktree's dev server (not 5173): Playwright's reuseExistingServer
    // would otherwise attach to the MAIN repo's server and silently test
    // stale code. Explicit --port still wins.
    const worktreePort = args.port ? null : resolveWorktreePort(appDir)
    const port = worktreePort ?? resolvePort(args.port as string | undefined)
    if (worktreePort && process.env.DEEPSPACE_PORT) {
      say(
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
      throw new Refusal(
        err instanceof Error ? err.message : 'Not logged in. Run `deepspace auth login` first.',
        'not_authenticated',
        { action: cliAction('deepspace', 'auth', 'login') },
      )
    }

    // Refresh the app-store secrets cache (config = wrangler env, or 'prd').
    // A repo without a DEEPSPACE_APP_ID hasn't been initialized — writeDevVars
    // below throws with the `deepspace app init` pointer, so skip the pull.
    let generatedSecretsCache: string | undefined
    const appIdForSecrets = readAppId(appDir, wranglerEnv)
    if (appIdForSecrets) {
      try {
        const refreshed = await refreshSecretsCache(DEPLOY_URL, token, appIdForSecrets, wranglerEnv)
        if (refreshed) {
          generatedSecretsCache = refreshed.rendered
          say(refreshed.summary)
        }
      } catch (err: unknown) {
        throw new Refusal(
          `Failed to refresh app secrets: ${err instanceof Error ? err.message : String(err)}`,
          'secrets_refresh_failed',
        )
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
          throw new Refusal(
            `Unknown test suite: ${suite}\nAvailable: smoke, api, e2e, unit, all`,
            'unknown_suite',
          )
        }
    }

    // The runner already printed every failure in detail; the refusal adds the
    // slug and the non-zero exit. Playwright's own code collapses to 1 — the
    // contract reserves 0/1/2 and every non-zero code here means "tests failed".
    if (exitCode !== 0) {
      throw new Refusal(`Test suite '${suite}' failed (exit ${exitCode}).`, 'tests_failed', {
        extra: { suite, port, exitCode },
      })
    }
    return { data: { suite, port, appDir, wranglerEnv: wranglerEnv ?? null } }
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
