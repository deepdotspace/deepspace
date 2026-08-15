import { describe, expect, it } from 'vitest'
import { PLAYWRIGHT_OUTPUT_DIR, playwrightTestArgs } from '../test'

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
