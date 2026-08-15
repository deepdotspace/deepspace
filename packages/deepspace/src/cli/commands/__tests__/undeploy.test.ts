import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureToken: vi.fn(async () => 'token'),
  resolveAppSelector: vi.fn(async (_url: string, _token: string, app: string) => app),
}))

vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))
vi.mock('../../lib/app-target', () => ({ resolveAppSelector: mocks.resolveAppSelector }))

import undeploy from '../undeploy'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // Clear the exit code the runtime records, so a refusal-path test cannot
  // poison the vitest worker's own exit code.
  process.exitCode = undefined
  mocks.ensureToken.mockClear()
  mocks.resolveAppSelector.mockClear()
})

describe('undeploy partial failure', () => {
  it('returns the exact retry action when registry takedown remains', async () => {
    const appId = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: 'The cloud script was removed, but registry takedown failed.',
            code: 'registry_takedown_failed',
            partial: true,
          },
          { status: 503 },
        ),
      ),
    )
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))

    const command = undeploy as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    // The runtime records the code on process.exitCode instead of calling
    // process.exit (see lib/command.ts); the afterEach above clears it.
    await command.run({ args: { name: appId, json: true } })
    expect(process.exitCode).toBe(2)

    expect(JSON.parse(lines[0])).toMatchObject({
      ok: false,
      code: 'registry_takedown_failed',
      actionRequired: true,
      appId,
      action: {
        cwd: process.cwd(),
        argv: ['deepspace', 'app', 'undeploy', appId],
      },
    })
  })

  it('preserves a terminal server error code', async () => {
    const appId = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Only the app owner can do this.', code: 'not_app_owner' },
          { status: 403 },
        ),
      ),
    )
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))

    const command = undeploy as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { name: appId, json: true } })

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      ok: false,
      code: 'not_app_owner',
      error: 'Only the app owner can do this.',
    })
  })
})
