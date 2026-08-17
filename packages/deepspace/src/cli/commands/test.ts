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
 * `--grep <pattern>`, `--project <name>`, and `--headed` forward to
 * `playwright test` on the Playwright suites.
 *
 * The default suite is a quick check, not a full run — it names every spec it
 * left out (prose line + `skippedSpecs` in the JSON envelope) so a green
 * summary never reads as "all of this app's tests passed".
 *
 * Port is `--port` > $DEEPSPACE_PORT > a stable linked-worktree port > 5173.
 * In any linked checkout the worktree's own default is used
 * so tests hit the worktree's server, not the main repo's. The chosen port is
 * exported as DEEPSPACE_PORT to the Playwright child so the config +
 * webServer both bind to the same address. Pass a different port per app to
 * run multiple apps
 * (and test suites) in parallel.
 *
 * Defined with the command runtime (lib/command.ts). The suite runner streams
 * playwright/vitest output live; under `--json` that stream goes to STDERR so
 * stdout carries exactly one line — the envelope — like every other command
 * (buffering it would cost the live feedback the command exists for; moving
 * it keeps both). The suite's own exit code collapses to the contract's 0/1.
 */

import { readAppId } from '../lib/app-identity'
import { readdirSync, type Dirent } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { sync as spawnSync } from 'cross-spawn'
import { ensureToken } from '../auth'
import { findAppDir, findChildApps } from '../lib/app-context'
import { resolveWorktreePort } from '../lib/launch-config'
import { PLATFORM_URLS } from '../env'
import { writeDevVars } from '../lib/dev-vars'
import { decodeJwtPayload } from '../../shared/jwt'
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
import { syncTestAccountStore } from '../lib/test-account-service'
// Same refusal text `dev` uses — one source so the two can't drift.
import { noAppDirMessage } from './dev'

const DEPLOY_URL = process.env.DEEPSPACE_DEPLOY_URL ?? PLATFORM_URLS.deploy
export const PLAYWRIGHT_OUTPUT_DIR = '.deepspace/test-results'

/** Flags forwarded verbatim to `playwright test`. Declared as real options
 *  (not a `--` passthrough) because the command runtime refuses undeclared
 *  flags. */
export interface PlaywrightForwardedFlags {
  grep?: string
  project?: string
  headed?: boolean
}

/** The two spec files the no-argument `deepspace test run` executes. */
export const DEFAULT_SUITE_SPECS: readonly string[] = ['tests/smoke.spec.ts', 'tests/api.spec.ts']

/**
 * The spec files the default suite does NOT run.
 *
 * The default is a deliberate quick-check, but its green summary used to claim
 * more than it ran: a scaffold's own `collab.spec.ts` (and every spec an agent
 * writes) never executed and nothing said so. Enumerating them here is what
 * makes the disclosure line possible — the set is the scaffold Playwright
 * config's `testMatch` (`tests/**\/*.spec.ts`) minus the two above. Paths are
 * relative to `appDir` and forward-slashed so they read as the arguments
 * `deepspace test run <file>` takes. Pure + exported for its unit test.
 */
export function specsSkippedByDefaultSuite(appDir: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // no tests/ dir (or unreadable) — nothing to disclose
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.spec.ts')) {
        found.push(relative(appDir, full).split(sep).join('/'))
      }
    }
  }
  walk(join(appDir, 'tests'))
  return found.filter((spec) => !DEFAULT_SUITE_SPECS.includes(spec)).sort()
}

export function playwrightTestArgs(
  testFiles: string[],
  flags: PlaywrightForwardedFlags = {},
): string[] {
  return [
    'playwright',
    'test',
    '--config',
    'tests/playwright.config.ts',
    '--output',
    PLAYWRIGHT_OUTPUT_DIR,
    ...(flags.grep ? ['--grep', flags.grep] : []),
    ...(flags.project ? ['--project', flags.project] : []),
    ...(flags.headed ? ['--headed'] : []),
    ...testFiles,
  ]
}

export default defineDeepspaceCommand({
  meta: {
    name: 'test',
    description: 'Run tests for your DeepSpace app',
  },
  jsonDescription: 'Stream test output on stderr; stdout is the single-line JSON result',
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
    grep: {
      type: 'string',
      description: 'Only run Playwright tests matching this pattern (forwarded to --grep)',
      required: false,
    },
    project: {
      type: 'string',
      description: 'Playwright project to run (forwarded to --project)',
      required: false,
    },
    headed: {
      type: 'boolean',
      description: 'Run Playwright browsers headed (forwarded to --headed)',
      default: false,
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
    suiteOutputToStderr = args.json === true
    const say = (line: string) => {
      if (!args.json) console.log(line)
    }
    preflightNodeVersion('test run')
    const suite = (args.suite as string | undefined) ?? 'default'
    const wranglerEnv =
      typeof args.env === 'string' && args.env.trim() ? args.env.trim() : undefined
    const forwarded: PlaywrightForwardedFlags = {
      grep: typeof args.grep === 'string' && args.grep ? args.grep : undefined,
      project: typeof args.project === 'string' && args.project ? args.project : undefined,
      headed: Boolean(args.headed),
    }

    // Resolve the app root by walking up from cwd, matching `deepspace dev start`.
    const start = resolve('.')
    const appDir = findAppDir(start)
    if (!appDir) {
      throw new Refusal(noAppDirMessage(start, findChildApps(start)), 'no_app_dir')
    }

    // Inside any linked Git worktree the default port must match that
    // checkout's dev server (not 5173): Playwright's reuseExistingServer
    // would otherwise attach to the MAIN repo's server and silently test
    // stale code. Explicit --port still wins.
    const configuredPort = Boolean(args.port) || Boolean(process.env.DEEPSPACE_PORT)
    const worktreePort = configuredPort ? null : resolveWorktreePort(appDir)
    const port = worktreePort ?? resolvePort(args.port as string | undefined)

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
        generatedSecretsCache = refreshed.rendered
        if (refreshed.summary) say(refreshed.summary)
      } catch (err: unknown) {
        throw new Refusal(
          `Failed to refresh app secrets: ${err instanceof Error ? err.message : String(err)}`,
          'secrets_refresh_failed',
        )
      }
    }

    await writeDevVars(appDir, ownerId, token, wranglerEnv, {
      generatedSecretsCache,
    })

    if (suite !== 'unit') {
      try {
        const { removed } = await syncTestAccountStore()
        if (removed > 0) say(`Removed ${removed} stale test account credential(s).`)
      } catch (error) {
        say(
          `Warning: could not reconcile test accounts: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    if (suite !== 'unit') {
      preflightWindowsWorkerd(appDir)
      ensurePlaywright(appDir)
    }

    let exitCode = 0
    // What the chosen suite did not run. Only the default suite can leave
    // specs out without being asked to (`smoke`/`api`/`<file>` were named by
    // the caller; `e2e`/`all` run everything), so this stays empty elsewhere.
    let skippedSpecs: string[] = []

    switch (suite) {
      case 'smoke':
        exitCode = runPlaywright(appDir, ['tests/smoke.spec.ts'], port, wranglerEnv, forwarded)
        break
      case 'api':
        exitCode = runPlaywright(appDir, ['tests/api.spec.ts'], port, wranglerEnv, forwarded)
        break
      case 'e2e':
        exitCode = runPlaywright(appDir, [], port, wranglerEnv, forwarded)
        break
      case 'unit':
        if (forwarded.grep || forwarded.project || forwarded.headed) {
          console.error('note: --grep/--project/--headed apply to Playwright suites and are ignored by `unit`')
        }
        exitCode = runVitest(appDir, wranglerEnv)
        break
      case 'all':
        exitCode = runVitest(appDir, wranglerEnv)
        if (exitCode === 0) exitCode = runPlaywright(appDir, [], port, wranglerEnv, forwarded)
        break
      case 'default':
        skippedSpecs = specsSkippedByDefaultSuite(appDir)
        exitCode = runPlaywright(appDir, [...DEFAULT_SUITE_SPECS], port, wranglerEnv, forwarded)
        // After the run, next to the runner's own summary — that summary is
        // what claimed "everything passed", so the correction belongs beside
        // it rather than scrolled off the top by the Playwright output.
        if (skippedSpecs.length > 0) {
          say(
            `skipped ${skippedSpecs.length} spec file(s) not in smoke+api ` +
              `(${skippedSpecs.join(', ')}) — run 'deepspace test run all'`,
          )
        }
        break
      default:
        if (suite.endsWith('.spec.ts')) {
          exitCode = runPlaywright(appDir, [suite], port, wranglerEnv, forwarded)
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
        extra: { suite, port, exitCode, skippedSpecs },
      })
    }
    return { data: { suite, port, appDir, wranglerEnv: wranglerEnv ?? null, skippedSpecs } }
  },
})

/**
 * Every suite runner goes through here, so `--env` reaches all of them.
 *
 * It is one chokepoint on purpose: the app's client reads its app id from the
 * wrangler config the run targets (`deepspace/build`), so a runner spawned
 * without this env resolves the DEFAULT environment's id. That made
 * `deepspace test run --env staging` run its unit half against production's
 * app id while its Playwright half used staging's — the two halves of one
 * command disagreeing about which app they were testing.
 */
/** Set once per invocation by `run`: `--json` moves the spawned suite's
 *  stdout to stderr so the envelope is stdout's only line. */
let suiteOutputToStderr = false

function runSuite(
  appDir: string,
  argv: string[],
  wranglerEnv: string | undefined,
  extraEnv: NodeJS.ProcessEnv = {},
): number {
  let wranglerConfig: PreparedWranglerEnvConfig
  try {
    wranglerConfig = prepareWranglerEnvConfig(appDir, wranglerEnv)
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
  try {
    const result = spawnSync('npx', argv, {
      cwd: appDir,
      // Under --json the child's stdout is routed to our stderr: the live
      // suite output stays visible and stdout stays a single JSON line.
      stdio: suiteOutputToStderr ? ['inherit', 2, 2] : 'inherit',
      env: wranglerViteEnv(process.env, wranglerConfig, extraEnv),
    })
    return result.status ?? 1
  } finally {
    wranglerConfig.cleanup()
  }
}

function runPlaywright(
  appDir: string,
  testFiles: string[],
  port: number,
  wranglerEnv?: string,
  flags: PlaywrightForwardedFlags = {},
): number {
  return runSuite(appDir, playwrightTestArgs(testFiles, flags), wranglerEnv, {
    DEEPSPACE_PORT: String(port),
    PLAYWRIGHT_HTML_OUTPUT_DIR: '.deepspace/playwright-report',
  })
}

/** Exported for its regression test: this runner used to spawn with no
 *  wrangler env at all. */
export function runVitest(appDir: string, wranglerEnv?: string): number {
  return runSuite(appDir, ['vitest', 'run', '--passWithNoTests'], wranglerEnv)
}
