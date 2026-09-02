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
 * run multiple apps (and test suites) in parallel. The runner always owns its
 * web server; a busy port is refused instead of attaching to whatever happens
 * to be listening there.
 *
 * Defined with the command runtime (lib/command.ts). The suite runner streams
 * playwright/vitest output live; under `--json` that stream goes to STDERR so
 * stdout carries exactly one line — the envelope — like every other command
 * (buffering it would cost the live feedback the command exists for; moving
 * it keeps both). The suite's own exit code collapses to the contract's 0/1.
 */

import { registerForLocalRun } from '../lib/app-registration'
import { existsSync, readFileSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { sync as spawnSync } from 'cross-spawn'
import { ensureToken, loginAction } from '../auth'
import { findAppDir } from '../lib/app-context'
import { resolveWorktreePort } from '../lib/launch-config'
import { PLATFORM_URLS } from '../env'
import { writeDevVars } from '../lib/dev-vars'
import { decodeJwtPayload } from '../../shared/jwt'
import { ensureInstallReady } from '../lib/install-status'
import { childStdio, ensurePlaywright, routeChildStdoutToStderr } from '../lib/playwright'
import { preflightNodeVersion, preflightWindowsWorkerd } from '../lib/preflight'
import { refreshSecretsCache } from '../lib/secrets'
import { ensurePortFree, DEFAULT_PORT, resolveDevServerPort } from '../lib/port'
import {
  prepareWranglerEnvConfig,
  wranglerViteEnv,
  type PreparedWranglerEnvConfig,
} from '../lib/wrangler-env'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import { syncTestAccountStore } from '../lib/test-account-service'
// Same refusal text `dev` uses — one source so the two can't drift.
import { noAppDirRefusal } from './dev'

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
    // The default list reporter stays for the live stream; the json reporter
    // is what lets the CLI surface runtime skips and their authored reasons,
    // which the list reporter swallows (AX C3, docs/audits/2026-09-01).
    '--reporter=list,json',
    ...(flags.grep ? ['--grep', flags.grep] : []),
    ...(flags.project ? ['--project', flags.project] : []),
    ...(flags.headed ? ['--headed'] : []),
    ...testFiles,
  ]
}

/** A test the runner skipped at runtime, with the reason its author gave. */
export interface SkippedTest {
  spec: string
  title: string
  reason: string | null
}

/**
 * Runtime skips from Playwright's json-reporter output. `test.skip(cond,
 * reason)` records the reason as a static `skip` annotation; the list
 * reporter never prints annotations, so this is the only place the authored
 * reason (e.g. "create 2 test accounts") reaches the person running tests.
 * Pure + exported for its unit test.
 */
export function skippedTestsFromPlaywrightJson(raw: string): SkippedTest[] {
  interface JsonTest {
    status?: unknown
    annotations?: Array<{ type?: unknown; description?: unknown }>
  }
  interface JsonSpec {
    file?: unknown
    title?: unknown
    tests?: JsonTest[]
  }
  interface JsonSuite {
    suites?: JsonSuite[]
    specs?: JsonSpec[]
  }
  const skipped: SkippedTest[] = []
  const walk = (suite: JsonSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== 'skipped') continue
        const note = test.annotations?.find((entry) => entry.type === 'skip')?.description
        skipped.push({
          spec: typeof spec.file === 'string' ? spec.file : '',
          title: typeof spec.title === 'string' ? spec.title : '',
          reason: typeof note === 'string' && note ? note : null,
        })
      }
    }
    for (const child of suite.suites ?? []) walk(child)
  }
  try {
    walk(JSON.parse(raw) as JsonSuite)
  } catch {
    return [] // a missing or unparseable report must not fail the run
  }
  return skipped
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
    // One switch for every child this run spawns — the dependency preflight
    // and the suite runner alike.
    routeChildStdoutToStderr(args.json === true)
    // stderr, not stdout: the suite runner owns stdout in human mode, and a
    // note printed there is lost in (or scrolled off by) its output — the
    // v0.26.0 linux AX pass captured a run's stderr and found the
    // skipped-specs correction missing entirely. stderr is where this CLI's
    // human-facing asides live.
    const say = (line: string) => {
      if (!args.json) console.error(line)
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
      throw noAppDirRefusal(start)
    }

    // Inside any linked Git worktree use that checkout's stable port by
    // default (shared precedence: lib/port.ts resolveDevServerPort). The
    // suite still starts and owns the server on that port.
    const port = resolveDevServerPort({
      arg: args.port as string | undefined,
      worktree: () => resolveWorktreePort(appDir),
    })

    // A LIVE concurrent install outranks everything else: it costs stat
    // calls to see, and `not_authenticated` while the scaffolder is visibly
    // installing hid the state it exists to report — and the heal's work is
    // never wasted on a logged-out user, because the install has to happen
    // before the suite can run regardless of how auth turns out. Before the
    // port check too, so dev and test agree on which refusal the same
    // directory state gets.
    ensureInstallReady(appDir)

    // The runner owns its server (reuseExistingServer: false), so any live
    // listener on the port is refused before auth work; a previous
    // run's server still shutting down gets a bounded grace first.
    if (suite !== 'unit') await ensurePortFree(port, '0.0.0.0')

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
        { action: loginAction() },
      )
    }

    // Refresh the app-store secrets cache (config = wrangler env, or 'prd').
    // An id-less checkout heals here: apps register on first use, so a fresh
    // scaffold's `test run` needs no `app init` step first.
    let generatedSecretsCache: string | undefined
    // Local-first for an EXISTING id; an id-less checkout whose mint failed
    // refuses with the mint's own cause (see registerForLocalRun).
    const appIdForSecrets = await registerForLocalRun(appDir, token, wranglerEnv)
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

    // CLI-001: an unresolvable id surfaces as writeDevVars' own Refusal,
    // already carrying the env-aware `app init` action.
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
    // Tests the runner itself skipped inside executed files — the fact
    // `skippedSpecs` deliberately does not cover (cli-contract.md).
    let skippedTests: SkippedTest[] = []
    const playwright = (testFiles: string[]): number => {
      const result = runPlaywright(appDir, testFiles, port, wranglerEnv, forwarded)
      skippedTests = result.skippedTests
      return result.exitCode
    }

    switch (suite) {
      case 'smoke':
        exitCode = playwright(['tests/smoke.spec.ts'])
        break
      case 'api':
        exitCode = playwright(['tests/api.spec.ts'])
        break
      case 'e2e':
        exitCode = playwright([])
        break
      case 'unit':
        if (forwarded.grep || forwarded.project || forwarded.headed) {
          console.error(
            'note: --grep/--project/--headed apply to Playwright suites and are ignored by `unit`',
          )
        }
        exitCode = runVitest(appDir, wranglerEnv)
        break
      case 'all':
        exitCode = runVitest(appDir, wranglerEnv)
        if (exitCode === 0) {
          // Between the two suites, not only at command start: vitest's
          // runtime can still be winding down on the port when Playwright
          // starts its own web server, and the leftover listener turned the
          // run into a phantom app bug (stale route table, 404 on a route
          // just added; v0.26.0 collab AX). Same guard as the start: a
          // bounded wait for a dying listener to release the port, an
          // immediate port_in_use refusal for one that still answers.
          await ensurePortFree(port, '0.0.0.0')
          exitCode = playwright([])
        }
        break
      case 'default':
        skippedSpecs = specsSkippedByDefaultSuite(appDir)
        exitCode = playwright([...DEFAULT_SUITE_SPECS])
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
          // A mistyped path used to surface as `tests_failed`,
          // indistinguishable from a red suite (r2 testing AX-6). Only
          // PATH-shaped args are checked (a separator, or absolute — resolve
          // handles both against appDir): a bare `collab.spec.ts` is a
          // Playwright FILTER that may match nested specs, so it passes
          // through to the runner untouched.
          const pathShaped = suite.includes('/') || suite.includes('\\')
          if (pathShaped && !existsSync(resolve(appDir, suite))) {
            throw new Refusal(
              `No spec file at ${suite}. Paths are relative to the app dir — list them with \`ls tests/\`.`,
              'spec_not_found',
            )
          }
          exitCode = playwright([suite])
        } else {
          // Whoever typed a name that is not a suite usually wanted one part
          // of one, so the refusal names both narrowing tools it has: a spec
          // path, and --grep. Without them the reader's next move is moving
          // spec files out of tests/ to isolate one.
          throw new Refusal(
            `Unknown test suite: ${suite}\n` +
              `Available: smoke, api, e2e, unit, all — or a path to one spec file ` +
              `(tests/<name>.spec.ts). To run part of a suite, add --grep <pattern>.`,
            'unknown_suite',
          )
        }
    }

    // Runtime skips get one line beside the runner's own summary — a green
    // run that silently skipped tests reads as complete (AX C3). The
    // authored reasons are the actionable part ("create 2 test accounts…").
    if (skippedTests.length > 0) {
      const reasons = [...new Set(skippedTests.map((test) => test.reason).filter(Boolean))]
      say(
        `${skippedTests.length} test(s) were skipped at runtime` +
          (reasons.length > 0 ? ` — ${reasons.join(' | ')}` : ''),
      )
    }

    // The runner already printed every failure in detail; the refusal adds the
    // slug and the non-zero exit. Playwright's own code collapses to 1 — the
    // contract reserves 0/1/2 and every non-zero code here means "tests failed".
    if (exitCode !== 0) {
      throw new Refusal(`Test suite '${suite}' failed (exit ${exitCode}).`, 'tests_failed', {
        extra: { suite, port, exitCode, skippedSpecs, skippedTests },
      })
    }
    return {
      data: { suite, port, appDir, wranglerEnv: wranglerEnv ?? null, skippedSpecs, skippedTests },
    }
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
      stdio: childStdio(),
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
): { exitCode: number; skippedTests: SkippedTest[] } {
  const resultsPath = join(appDir, '.deepspace', 'playwright-results.json')
  rmSync(resultsPath, { force: true })
  const exitCode = runSuite(appDir, playwrightTestArgs(testFiles, flags), wranglerEnv, {
    DEEPSPACE_PORT: String(port),
    PLAYWRIGHT_HTML_OUTPUT_DIR: '.deepspace/playwright-report',
    PLAYWRIGHT_JSON_OUTPUT_FILE: resultsPath,
  })
  let raw = ''
  try {
    raw = readFileSync(resultsPath, 'utf-8')
  } catch {
    // No report (older runner, crashed run): skips stay unknown, not fatal.
  }
  return { exitCode, skippedTests: skippedTestsFromPlaywrightJson(raw) }
}

/** Exported for its regression test: this runner used to spawn with no
 *  wrangler env at all. */
export function runVitest(appDir: string, wranglerEnv?: string): number {
  return runSuite(appDir, ['vitest', 'run', '--passWithNoTests'], wranglerEnv)
}
