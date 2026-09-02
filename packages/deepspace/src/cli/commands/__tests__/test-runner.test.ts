import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }))
vi.mock('cross-spawn', () => ({ sync: spawnSyncMock }))

import testCommand, {
  DEFAULT_SUITE_SPECS,
  PLAYWRIGHT_OUTPUT_DIR,
  playwrightTestArgs,
  runVitest,
  skippedTestsFromPlaywrightJson,
  specsSkippedByDefaultSuite,
} from '../test'
import * as appContext from '../../lib/app-context'
import { Refusal } from '../../lib/command'
import * as authModule from '../../auth'
import * as devVarsModule from '../../lib/dev-vars'
import * as installStatusModule from '../../lib/install-status'
import * as playwrightModule from '../../lib/playwright'
import { childStdio } from '../../lib/playwright'
import * as portModule from '../../lib/port'
import * as preflightModule from '../../lib/preflight'
import * as testAccountModule from '../../lib/test-account-service'

const STAGING_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0456'
const DEFAULT_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0123'

let appDir: string | undefined

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  if (appDir) rmSync(appDir, { recursive: true, force: true })
  appDir = undefined
  spawnSyncMock.mockReset()
})

function makeAppWithSpecs(specs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-test-skipped-'))
  // No DEEPSPACE_APP_ID: an uninitialized app skips the secrets-cache
  // refresh, so this suite never reaches the network.
  writeFileSync(join(dir, 'wrangler.toml'), 'name = "demo"\n')
  for (const spec of specs) {
    mkdirSync(join(dir, spec, '..'), { recursive: true })
    writeFileSync(join(dir, spec), 'test.skip("x", () => {})\n')
  }
  appDir = dir
  return dir
}

async function runDefaultSuite(
  dir: string,
  json: boolean,
  extraArgs: Record<string, unknown> = {},
) {
  const lines: string[] = []
  const logLines: string[] = []
  vi.spyOn(appContext, 'findAppDir').mockReturnValue(dir)
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    logLines.push(String(line))
    lines.push(String(line))
  })
  // Human-mode asides print on stderr (the suite runner owns stdout) — the
  // harness collects both for `lines`, while the JSON envelope still parses
  // from stdout alone.
  vi.spyOn(console, 'error').mockImplementation((line?: unknown) => lines.push(String(line)))
  vi.spyOn(preflightModule, 'preflightNodeVersion').mockImplementation(() => {})
  vi.spyOn(preflightModule, 'preflightWindowsWorkerd').mockImplementation(() => {})
  vi.spyOn(installStatusModule, 'ensureInstallReady').mockImplementation(() => {})
  vi.spyOn(playwrightModule, 'ensurePlaywright').mockImplementation(() => {})
  vi.spyOn(portModule, 'ensurePortFree').mockResolvedValue(undefined)
  vi.spyOn(testAccountModule, 'syncTestAccountStore').mockResolvedValue({
    accounts: [],
    removed: 0,
  })
  vi.spyOn(devVarsModule, 'writeDevVars').mockResolvedValue(undefined as never)
  // sub = the id decodeJwtPayload reads to mint the local dev vars.
  const payload = Buffer.from(JSON.stringify({ sub: 'user_1' })).toString('base64url')
  vi.spyOn(authModule, 'ensureToken').mockResolvedValue(`h.${payload}.s`)
  spawnSyncMock.mockReturnValue({ status: 0 })

  // The runtime prints the envelope and returns nothing (lib/command.ts),
  // so under --json the last log line IS the machine-readable result.
  const command = testCommand as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }
  process.exitCode = undefined
  await command.run({ args: { json, ...extraArgs } })
  return {
    lines,
    envelope: json ? (JSON.parse(logLines[logLines.length - 1]) as Record<string, unknown>) : null,
  }
}

/**
 * The default suite is a quick check that used to claim more than it ran: the
 * scaffold's own `collab.spec.ts` (and every spec an agent adds) never
 * executed, and the green summary said nothing about it.
 */
describe('default-suite disclosure', () => {
  it('lists every spec the default suite leaves out, and nothing it runs', () => {
    const dir = makeAppWithSpecs([
      ...DEFAULT_SUITE_SPECS,
      'tests/collab.spec.ts',
      'tests/nested/billing.spec.ts',
      'tests/helpers/global-setup.ts',
    ])
    expect(specsSkippedByDefaultSuite(dir)).toEqual([
      'tests/collab.spec.ts',
      'tests/nested/billing.spec.ts',
    ])
  })

  it('is empty when the app only has the two default specs', () => {
    expect(specsSkippedByDefaultSuite(makeAppWithSpecs([...DEFAULT_SUITE_SPECS]))).toEqual([])
  })

  it('prints the skipped specs and carries them in the JSON envelope', async () => {
    const dir = makeAppWithSpecs([...DEFAULT_SUITE_SPECS, 'tests/collab.spec.ts'])

    const human = await runDefaultSuite(dir, false)
    expect(human.lines).toContain(
      "skipped 1 spec file(s) not in smoke+api (tests/collab.spec.ts) — run 'deepspace test run all'",
    )

    vi.restoreAllMocks()
    const machine = await runDefaultSuite(dir, true)
    // --json suppresses the prose, so the envelope has to carry it.
    expect(machine.envelope).toMatchObject({
      ok: true,
      suite: 'default',
      skippedSpecs: ['tests/collab.spec.ts'],
    })
  })

  it('says nothing when the default suite is the whole suite', async () => {
    const dir = makeAppWithSpecs([...DEFAULT_SUITE_SPECS])
    const { lines } = await runDefaultSuite(dir, false)
    expect(lines.join('\n')).not.toContain('skipped')

    vi.restoreAllMocks()
    const { envelope } = await runDefaultSuite(dir, true)
    expect(envelope).toMatchObject({ ok: true, skippedSpecs: [] })
  })
})

/** The stdio the suite runner spawned Playwright with. */
function suiteSpawnStdio(): unknown {
  const call = spawnSyncMock.mock.calls.find(
    (args: unknown[]) => Array.isArray(args[1]) && args[1][0] === 'playwright',
  )
  return (call?.[2] as { stdio: unknown } | undefined)?.stdio
}

describe('--json output routing', () => {
  it('routes every child a run spawns, preflight included, off stdout', async () => {
    const dir = makeAppWithSpecs([...DEFAULT_SUITE_SPECS])
    await runDefaultSuite(dir, true)

    // The suite runner...
    expect(suiteSpawnStdio()).toEqual(['inherit', 2, 2])
    // ...and the dependency preflight (mocked here, exercised in
    // lib/__tests__/playwright.test.ts) read the SAME flag, so neither can be
    // fixed without the other.
    expect(childStdio()).toEqual(['inherit', 2, 2])
  })

  it('leaves child output on stdout when the caller wants to watch it', async () => {
    const dir = makeAppWithSpecs([...DEFAULT_SUITE_SPECS])
    await runDefaultSuite(dir, false)

    expect(suiteSpawnStdio()).toBe('inherit')
    expect(childStdio()).toBe('inherit')
  })
})

/**
 * The suites are a fixed vocabulary, so this refusal fires exactly when someone
 * wants to run one spec — the moment to name the two ways to do it.
 */
describe('unknown suite refusal', () => {
  it('names the spec-file form and --grep, not just the suite list', async () => {
    const dir = makeAppWithSpecs([...DEFAULT_SUITE_SPECS])
    const { lines } = await runDefaultSuite(dir, true, { suite: 'probe' })

    const envelope = JSON.parse(lines[lines.length - 1]) as { code: string; error: string }
    expect(envelope.code).toBe('unknown_suite')
    expect(envelope.error).toContain('smoke, api, e2e, unit, all')
    expect(envelope.error).toContain('tests/<name>.spec.ts')
    expect(envelope.error).toContain('--grep <pattern>')
  })
})

describe('outside an app directory', () => {
  it('refuses not_in_app_repo — the one code every command gives this state (was no_app_dir)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-test-noapp-'))
    appDir = dir
    const lines: string[] = []
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(null)
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    vi.spyOn(preflightModule, 'preflightNodeVersion').mockImplementation(() => {})
    const command = testCommand as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { json: true } })
    const envelope = JSON.parse(lines[lines.length - 1]) as { code: string; error: string }
    expect(envelope.code).toBe('not_in_app_repo')
    expect(envelope.error).toMatch(/No wrangler.toml found at or above/)
    expect(process.exitCode).toBe(1)
  })
})

describe('Playwright server ownership', () => {
  it('refuses a busy port before installing or spawning Playwright', async () => {
    const dir = makeAppWithSpecs([...DEFAULT_SUITE_SPECS])
    const lines: string[] = []
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(dir)
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    vi.spyOn(preflightModule, 'preflightNodeVersion').mockImplementation(() => {})
    vi.spyOn(installStatusModule, 'ensureInstallReady').mockImplementation(() => {})
    const ensurePlaywright = vi.spyOn(playwrightModule, 'ensurePlaywright')
    vi.spyOn(portModule, 'ensurePortFree').mockRejectedValue(
      new Refusal('Port 5199 is already in use.', 'port_in_use', { extra: { port: 5199 } }),
    )

    const command = testCommand as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { json: true, port: '5199' } })

    expect(ensurePlaywright).not.toHaveBeenCalled()
    expect(spawnSyncMock).not.toHaveBeenCalled()
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      ok: false,
      code: 'port_in_use',
      port: 5199,
    })
  })

  it('does not probe a port for unit tests', async () => {
    const dir = makeAppWithSpecs([])
    const probe = vi.spyOn(portModule, 'ensurePortFree')
    await runDefaultSuite(dir, true, { suite: 'unit' })
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('Playwright artifact routing', () => {
  it('keeps CLI-run artifacts inside the already-ignored .deepspace directory', () => {
    expect(playwrightTestArgs(['tests/smoke.spec.ts'])).toEqual([
      'playwright',
      'test',
      '--config',
      'tests/playwright.config.ts',
      '--output',
      PLAYWRIGHT_OUTPUT_DIR,
      '--reporter=list,json',
      'tests/smoke.spec.ts',
    ])
    expect(PLAYWRIGHT_OUTPUT_DIR).toMatch(/^\.deepspace\//)
  })

  it('threads --grep/--project/--headed through, ahead of the file filters', () => {
    expect(
      playwrightTestArgs(['tests/smoke.spec.ts'], {
        grep: 'presence',
        project: 'chromium',
        headed: true,
      }),
    ).toEqual([
      'playwright',
      'test',
      '--config',
      'tests/playwright.config.ts',
      '--output',
      PLAYWRIGHT_OUTPUT_DIR,
      '--reporter=list,json',
      '--grep',
      'presence',
      '--project',
      'chromium',
      '--headed',
      'tests/smoke.spec.ts',
    ])
  })

  it('omits forwarded flags that were not set', () => {
    expect(playwrightTestArgs([], { headed: false })).toEqual([
      'playwright',
      'test',
      '--config',
      'tests/playwright.config.ts',
      '--output',
      PLAYWRIGHT_OUTPUT_DIR,
      '--reporter=list,json',
    ])
  })
})

/**
 * `deepspace test run --env staging` is ONE command, and both of its halves
 * must be testing the same app. The client resolves its app id from the
 * wrangler config the run points at (deepspace/build), so a runner spawned
 * without that env resolves the DEFAULT environment's id — which had the unit
 * half running against production's id while the Playwright half used
 * staging's.
 */
describe('suite runners resolve --env', () => {
  function makeApp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ds-test-runner-'))
    writeFileSync(
      join(dir, 'wrangler.toml'),
      [
        'name = "demo"',
        '[vars]',
        `DEEPSPACE_APP_ID = "${DEFAULT_ID}"`,
        '[env.staging]',
        'name = "demo-staging"',
        '[env.staging.vars]',
        `DEEPSPACE_APP_ID = "${STAGING_ID}"`,
        '',
      ].join('\n'),
    )
    appDir = dir
    return dir
  }

  /**
   * The generated config is deleted as the run unwinds, so the child's view of
   * it has to be taken from inside the spawn — which is also the only place
   * that proves what the runner would actually have built against.
   */
  function captureSpawnedConfig(): { value: string | null } {
    const captured: { value: string | null } = { value: null }
    spawnSyncMock.mockImplementation(
      (_command: string, _argv: string[], options: { env: NodeJS.ProcessEnv }) => {
        const path = options.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
        captured.value = path ? readFileSync(path, 'utf8') : null
        return { status: 0 }
      },
    )
    return captured
  }

  it('runs vitest against the environment the run selected', () => {
    const dir = makeApp()
    const captured = captureSpawnedConfig()

    expect(runVitest(dir, 'staging')).toBe(0)

    expect(captured.value).toContain(STAGING_ID)
    expect(captured.value).not.toContain(DEFAULT_ID)
  })

  it('leaves the environment alone when no --env was asked for', () => {
    const dir = makeApp()
    spawnSyncMock.mockReturnValue({ status: 0 })

    expect(runVitest(dir)).toBe(0)

    const options = spawnSyncMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }
    expect(options.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH).toBeUndefined()
  })
})

describe('skippedTestsFromPlaywrightJson (runtime skips reach the summary)', () => {
  // AX C3 (docs/audits/2026-09-01): `test run --json` said skippedSpecs: []
  // while Playwright skipped 3 tests, and the scaffold's authored reason
  // ("create 2 test accounts …") was swallowed by the list reporter.
  it('extracts skipped tests and their authored reasons from the json report', () => {
    const report = JSON.stringify({
      suites: [
        {
          specs: [
            {
              file: 'tests/collab.spec.ts',
              title: 'two users see each other',
              tests: [
                {
                  status: 'skipped',
                  annotations: [
                    { type: 'skip', description: 'Needs 2 usable test accounts, found 0.' },
                  ],
                },
              ],
            },
            {
              file: 'tests/smoke.spec.ts',
              title: 'loads',
              tests: [{ status: 'expected' }],
            },
          ],
          suites: [
            {
              specs: [
                {
                  file: 'tests/collab.spec.ts',
                  title: 'presence updates live',
                  tests: [{ status: 'skipped' }],
                },
              ],
            },
          ],
        },
      ],
    })
    expect(skippedTestsFromPlaywrightJson(report)).toEqual([
      {
        spec: 'tests/collab.spec.ts',
        title: 'two users see each other',
        reason: 'Needs 2 usable test accounts, found 0.',
      },
      { spec: 'tests/collab.spec.ts', title: 'presence updates live', reason: null },
    ])
  })

  it('treats a missing or unparseable report as no known skips, never a failure', () => {
    expect(skippedTestsFromPlaywrightJson('')).toEqual([])
    expect(skippedTestsFromPlaywrightJson('not json')).toEqual([])
  })
})
