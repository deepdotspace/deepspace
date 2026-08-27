/**
 * `app transfer` output contracts: an accept that only replayed an earlier
 * acceptance must never read as a completed handshake, `status` must name the
 * offerer (the recipient's seat used to see a bare `app → you`), and `offer`
 * must say what acceptance costs the offerer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureToken: vi.fn(async () => 'token'),
  resolveAppTarget: vi.fn(async (_url: string, _token: string, app?: string) => app ?? APP),
  requireAppIdArg: vi.fn((app?: string) => String(app)),
}))

vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))
vi.mock('../../lib/app-target', () => ({
  resolveAppTarget: mocks.resolveAppTarget,
  requireAppIdArg: mocks.requireAppIdArg,
}))

import transfer from '../transfer'

const APP = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'

type Runner = { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }
const sub = (name: 'offer' | 'status' | 'accept'): Runner =>
  (transfer as unknown as { subCommands: Record<string, Runner> }).subCommands[name]

function captureLog(): string[] {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
  return lines
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  process.exitCode = undefined
})

describe('accept', () => {
  it('reports a fresh acceptance as ownership gained', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, replayed: false })),
    )
    const lines = captureLog()

    await sub('accept').run({ args: { app: APP, json: false } })

    expect(lines.join('\n')).toContain(`You now own ${APP}`)
    expect(lines.join('\n')).not.toContain('collaborator(s) added by the previous owner')
  })

  it('names the collaborators the previous owner left on the app', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ ok: true, replayed: false, inheritedCollaborators: ['u-1', 'u-2'] }),
      ),
    )
    const lines = captureLog()

    await sub('accept').run({ args: { app: APP, json: false } })

    expect(lines.join('\n')).toContain('2 collaborator(s) added by the previous owner stay on the app')
    expect(lines.join('\n')).toContain(`app collaborators list --app ${APP}`)

    lines.length = 0
    await sub('accept').run({ args: { app: APP, json: true } })
    expect(JSON.parse(lines[0])).toMatchObject({
      ok: true,
      accepted: true,
      inheritedCollaborators: ['u-1', 'u-2'],
    })
  })

  it('says when the collaborator listing was unavailable instead of implying none', async () => {
    // An older platform (or a failed listing) omits the field — that must not
    // read as "no collaborators": these principals hold deploy and plaintext
    // secrets access.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, replayed: false })),
    )
    const lines = captureLog()

    await sub('accept').run({ args: { app: APP, json: false } })
    expect(lines.join('\n')).toContain('Could not list collaborators')

    lines.length = 0
    await sub('accept').run({ args: { app: APP, json: true } })
    expect(JSON.parse(lines[0])).not.toHaveProperty('inheritedCollaborators')
  })

  it('says a replay is a replay — not an offer it just accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ ok: true, replayed: true, acceptedAt: '2026-08-01T00:00:00.000Z' }),
      ),
    )
    const lines = captureLog()

    await sub('accept').run({ args: { app: APP, json: false } })

    const out = lines.join('\n')
    expect(out).toContain('already yours')
    expect(out).toContain('2026-08-01T00:00:00.000Z')
    expect(out).toContain('no pending offer was accepted')
    expect(out).not.toContain('You now own')
  })

  it('--json marks a replay as not accepted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ ok: true, replayed: true, acceptedAt: '2026-08-01T00:00:00.000Z' }),
      ),
    )
    const lines = captureLog()

    await sub('accept').run({ args: { app: APP, json: true } })

    expect(JSON.parse(lines[0])).toMatchObject({
      ok: true,
      app: APP,
      accepted: false,
      replayed: true,
      acceptedAt: '2026-08-01T00:00:00.000Z',
    })
  })
})

describe('status', () => {
  it('names both parties, so the recipient can see who offered it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          transfer: {
            fromEmailDisplay: 'owner@acme.com',
            toEmailDisplay: 'you@acme.com',
            expiresAt: '2026-08-08T00:00:00.000Z',
          },
        }),
      ),
    )
    const lines = captureLog()

    await sub('status').run({ args: { app: APP, json: false } })

    expect(lines.join('\n')).toContain('from owner@acme.com to you@acme.com')
  })
})

describe('offer', () => {
  it('states that acceptance strips the offerer of all access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Response.json({ toUserId: 'user-2', expiresAt: '2026-08-08T00:00:00.000Z' })
          : Response.json({ transfer: null }),
      ),
    )
    const lines = captureLog()

    await sub('offer').run({ args: { email: 'them@acme.com', app: APP, json: false } })

    const out = lines.join('\n')
    expect(out).toContain('lose ALL access')
    expect(out).toContain('not kept on as a')
    expect(out).toContain('deepspace app list')
  })

  it('the --json envelope carries the same consequence as onAcceptance', async () => {
    // v0.26.0 collab AX F7: the seat most likely to fire this verb without a
    // human reading the screen was the one that never saw the warning.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Response.json({ toUserId: 'user-2', expiresAt: '2026-08-08T00:00:00.000Z' })
          : Response.json({ transfer: null }),
      ),
    )
    const lines = captureLog()
    await sub('offer').run({ args: { email: 'them@acme.com', app: APP, json: true } })
    const envelope = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>
    expect(envelope).toMatchObject({ ok: true, app: APP, email: 'them@acme.com' })
    expect(String(envelope.onAcceptance)).toContain('lose all access')
  })
})
