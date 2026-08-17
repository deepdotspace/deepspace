/**
 * `app list` rendering: an app with no live route shows the name it still
 * holds (not `—`), and an incoming transfer offer — which belongs to no app
 * the caller can access yet — is discoverable here.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ ensureToken: vi.fn(async () => 'token') }))
vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))

import list from '../apps'

const APP = 'app_01HZXYABCDEFGHJKMNPQRSTVWX'
const OFFERED = 'app_01HZXYABCDEFGHJKMNPQRSTVWY'

function stubList(body: Record<string, unknown>): string[] {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body)),
  )
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
  return lines
}

const command = list as unknown as {
  run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  process.exitCode = undefined
})

describe('app list', () => {
  it('shows an undeployed app’s reserved name and when the hold lapses', async () => {
    const lines = stubList({
      apps: [
        {
          appId: APP,
          status: 'undeployed',
          createdAt: '2026-08-01T00:00:00.000Z',
          deployedAt: null,
          name: null,
          url: null,
          role: 'owner',
          reservedName: 'pulseboard',
          reservedUntil: '2026-09-15T00:00:00.000Z',
        },
      ],
      pendingTransfers: [],
    })

    await command.run({ args: { json: false } })

    const out = lines.join('\n')
    expect(out).toContain('pulseboard (reserved)')
    expect(out).toContain('held for you until 2026-09-15T00:00:00.000Z')
    expect(out).not.toMatch(/^—/m)
  })

  it('shows the old name a renamed, still-serving app holds', async () => {
    // After a rename the app has a live name AND a reservation; the hold
    // must not disappear from the human output just because `name` is set.
    const lines = stubList({
      apps: [
        {
          appId: APP,
          status: 'deployed',
          createdAt: '2026-08-01T00:00:00.000Z',
          deployedAt: '2026-08-02T00:00:00.000Z',
          name: 'pulseboard-v2',
          url: 'https://pulseboard-v2.app.space',
          role: 'owner',
          reservedName: 'pulseboard',
          reservedUntil: '2026-09-15T00:00:00.000Z',
        },
      ],
      pendingTransfers: [],
    })

    await command.run({ args: { json: false } })

    const out = lines.join('\n')
    expect(out).toContain('pulseboard-v2')
    expect(out).toContain('pulseboard — held for you until 2026-09-15T00:00:00.000Z')
    expect(out).toContain('now serves pulseboard-v2')
  })

  it('still renders — for an app that holds no name at all', async () => {
    const lines = stubList({
      apps: [
        {
          appId: APP,
          status: 'active',
          createdAt: '2026-08-01T00:00:00.000Z',
          deployedAt: null,
          name: null,
          url: null,
          role: 'owner',
          reservedName: null,
          reservedUntil: null,
        },
      ],
      pendingTransfers: [],
    })

    await command.run({ args: { json: false } })

    expect(lines.join('\n')).toContain('—')
  })

  it('surfaces a transfer offer addressed to the caller, with how to accept it', async () => {
    const lines = stubList({
      apps: [],
      pendingTransfers: [
        {
          appId: OFFERED,
          fromUserId: 'user-1',
          createdAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-08-08T00:00:00.000Z',
        },
      ],
    })

    await command.run({ args: { json: false } })

    const out = lines.join('\n')
    expect(out).toContain('Transfer offers waiting for you')
    expect(out).toContain(OFFERED)
    expect(out).toContain('2026-08-08T00:00:00.000Z')
    expect(out).toContain('deepspace app transfer accept --app')
    // The "no apps yet" line would hide the offer entirely.
    expect(out).not.toContain('No apps yet')
  })

  it('carries the offers into --json', async () => {
    const lines = stubList({
      apps: [],
      pendingTransfers: [
        {
          appId: OFFERED,
          fromUserId: 'user-1',
          createdAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-08-08T00:00:00.000Z',
        },
      ],
    })

    await command.run({ args: { json: true } })

    expect(JSON.parse(lines[0])).toMatchObject({
      ok: true,
      pendingTransfers: [{ appId: OFFERED, fromUserId: 'user-1' }],
    })
  })

  it('tolerates an older deploy worker that sends no offers field', async () => {
    const lines = stubList({ apps: [] })

    await command.run({ args: { json: false } })

    expect(lines.join('\n')).toContain('No apps yet')
  })
})
