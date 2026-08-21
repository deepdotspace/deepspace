import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureToken: vi.fn(async () => 'token'),
  resolveAppSelector: vi.fn(async (_url: string, _token: string, app: string) => app),
  confirm: vi.fn(async (_opts: { message: string }) => false),
}))

vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))
vi.mock('../../lib/app-target', () => ({ resolveAppSelector: mocks.resolveAppSelector }))
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>()
  return { ...actual, intro: vi.fn(), confirm: mocks.confirm }
})

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

describe('undeploy idempotence', () => {
  const run = async (args: Record<string, unknown>) => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    const command = undeploy as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run(args.json ? { args } : { args })
    return JSON.parse(lines[0]) as Record<string, unknown>
  }

  it('reports the released hosts and alreadyUndeployed:false on a real takedown', async () => {
    const appId = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, releasedHosts: ['my-shop.app.space'] })),
    )
    expect(await run({ name: appId, json: true })).toEqual({
      ok: true,
      appId,
      releasedHosts: ['my-shop.app.space'],
      alreadyUndeployed: false,
    })
    expect(process.exitCode).toBe(0)
  })

  it('reports alreadyUndeployed:true when the registry released no route (second undeploy)', async () => {
    const appId = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, releasedHosts: [] })))
    expect(await run({ name: appId, json: true })).toEqual({
      ok: true,
      appId,
      releasedHosts: [],
      alreadyUndeployed: true,
    })
    expect(process.exitCode).toBe(0)
  })
})

describe('undeploy consent', () => {
  it('names the app and states that its data is destroyed, then honours No', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const command = undeploy as unknown as {
        run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
      }
      await command.run({ args: { name: 'my-shop' } })
      expect(process.exitCode).toBe(1)
      const message = String(mocks.confirm.mock.calls[0]?.[0]?.message)
      expect(message).toContain('my-shop')
      expect(message).toContain('destroyed')
      expect(message).toContain('Secrets and the registration stay')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
    }
  })
})
