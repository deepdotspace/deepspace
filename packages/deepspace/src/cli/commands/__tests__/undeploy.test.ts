import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureToken: vi.fn(async () => 'token'),
  resolveAppSelector: vi.fn(async (_url: string, _token: string, app: string) => app),
  listApps: vi.fn(async () => [] as unknown[]),
  confirm: vi.fn(async (_opts: { message: string }) => false),
}))

vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))
// The takedown wait probes real sockets (see edge-propagation.test.ts for the
// wait's own coverage); here it must not reach for my-shop.app.space.
vi.mock('../../lib/edge-propagation', () => ({
  waitForHostReleased: vi.fn(async () => 'confirmed' as const),
}))
vi.mock('../../lib/app-target', () => ({
  resolveAppSelector: mocks.resolveAppSelector,
  listApps: mocks.listApps,
}))
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
  mocks.listApps.mockReset()
  mocks.listApps.mockResolvedValue([])
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
    await command.run({ args: { name: appId, json: true, yes: true } })
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
    await command.run({ args: { name: appId, json: true, yes: true } })

    expect(process.exitCode).toBe(1)
    const envelope = JSON.parse(lines[0]) as Record<string, unknown>
    expect(envelope).toMatchObject({ ok: false, code: 'not_app_owner' })
    // The server sentence survives, with the shared hint's recoveries after it.
    expect(String(envelope.error)).toContain('Only the app owner can do this.')
    expect(String(envelope.error)).toContain('app init --new-id')
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
    expect(await run({ name: appId, json: true, yes: true })).toEqual({
      ok: true,
      appId,
      releasedHosts: ['my-shop.app.space'],
      alreadyUndeployed: false,
      released: 'confirmed',
    })
    expect(process.exitCode).toBe(0)
  })

  it('reports alreadyUndeployed:true when the registry released no route (second undeploy)', async () => {
    const appId = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, releasedHosts: [] })))
    expect(await run({ name: appId, json: true, yes: true })).toEqual({
      ok: true,
      appId,
      releasedHosts: [],
      alreadyUndeployed: true,
      released: null,
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
      expect(message).toContain('Secrets, app files, and the registration stay')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })
    }
  })

  it('refuses --json without --yes instead of treating the command as consent', async () => {
    // "The command itself is consent" made --yes decorative exactly where a
    // typo'd app id is most destructive — both 0.25.0 AX audits took a live
    // app to 404 through this path without meaning to.
    const appId = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    const command = undeploy as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { name: appId, json: true } })
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      ok: false,
      code: 'confirmation_required',
      appId,
    })
    // Refused BEFORE the DELETE — nothing was taken down.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('ownership before consent', () => {
  const appId = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'
  const run = async (args: Record<string, unknown>) => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    const command = undeploy as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args })
    return lines
  }

  it('a collaborator is refused not_app_owner BEFORE the consent gate', async () => {
    // v0.26.0 collab AX F3: the consent refusal said "re-run with --yes" to a
    // caller the server would then refuse anyway — teaching the wrong next
    // step on the most destructive verb.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    mocks.listApps.mockResolvedValue([{ appId, role: 'collaborator' }])
    const lines = await run({ name: appId, json: true })
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(lines[0])).toMatchObject({ ok: false, code: 'not_app_owner', appId })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an owner (or an app the listing cannot see) still reaches the consent gate', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    mocks.listApps.mockResolvedValue([{ appId, role: 'owner' }])
    const lines = await run({ name: appId, json: true })
    expect(JSON.parse(lines[0])).toMatchObject({ ok: false, code: 'confirmation_required' })
    // A listing failure is advisory — the server still enforces ownership.
    mocks.listApps.mockRejectedValue(new Error('registry blip'))
    const lines2 = await run({ name: appId, json: true })
    expect(JSON.parse(lines2[0])).toMatchObject({ ok: false, code: 'confirmation_required' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
