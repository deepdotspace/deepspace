import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { devExitSucceeded } from '../dev'

describe('development server exit handling', () => {
  it('treats an interrupt exit as success only after this process received the signal', () => {
    expect(devExitSucceeded(null, false)).toBe(true)
    expect(devExitSucceeded(0, false)).toBe(true)
    expect(devExitSucceeded(130, true)).toBe(true)
    expect(devExitSucceeded(130, false)).toBe(false)
    expect(devExitSucceeded(143, true)).toBe(true)
    expect(devExitSucceeded(1, false)).toBe(false)
  })
})

describe('app_not_found remedy is env-scoped', () => {
  // The remedy lives at ONE chokepoint — writeDevVars (lib/dev-vars.ts),
  // where the ApiError originates — so callers cannot drift. A bare
  // `app init` under --env either no-ops on the prod id or mints a new app
  // into the top-level [vars] slot: pin the env spread there, and pin that
  // no caller has grown its own copy back. Whitespace-tolerant across the
  // spellings prettier can produce.
  const ENV_SCOPED_ARGV =
    /'app',\s*'init',\s*\.\.\.\(\s*wranglerEnv\s*\?\s*\['--env',\s*wranglerEnv\]\s*:\s*\[\]\s*\)/

  it('the writeDevVars chokepoint keeps --env on the app-init action', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../lib/dev-vars.ts', import.meta.url)),
      'utf8',
    )
    expect(source).toMatch(ENV_SCOPED_ARGV)
    // Formatting-tolerant: any argv that closes right after 'init' (no env
    // spread) is the bare, wrong-slot remedy — whatever prettier did to it.
    expect(source).not.toMatch(/'app',\s*'init',?\s*\]/)
  })

  it('no caller re-builds its own app-init remedy', () => {
    for (const file of ['../dev.ts', '../test.ts', '../secrets.ts', '../deploy/secrets.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      expect(source, file).not.toMatch(/'app',\s*'init'/)
    }
  })
})
