import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }))
vi.mock('cross-spawn', () => ({ sync: spawnSyncMock }))

import { PLAYWRIGHT_OUTPUT_DIR, playwrightTestArgs, runVitest } from '../test'

const STAGING_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0456'
const DEFAULT_ID = 'app_01JG8QK4M2N7P9RSTVWXYZ0123'

let appDir: string | undefined

afterEach(() => {
  if (appDir) rmSync(appDir, { recursive: true, force: true })
  appDir = undefined
  spawnSyncMock.mockReset()
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
