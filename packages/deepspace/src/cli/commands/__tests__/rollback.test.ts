import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureToken: vi.fn(async () => 'token'),
  resolveAppTarget: vi.fn(async () => 'app_01HZXYABCDEFGHJKMNPQRSTVWX'),
}))
vi.mock('../../auth', () => ({ ensureToken: mocks.ensureToken }))
vi.mock('../../lib/app-target', () => ({
  resolveAppTarget: mocks.resolveAppTarget,
  assertAppTargetResolvable: () => {},
  parseWranglerEnvArg: () => ({ wranglerEnv: undefined }),
}))

import rollback, { pickPreviousRelease, unavailableDoGuardRefusal } from '../rollback'

describe('pickPreviousRelease (default rollback target)', () => {
  // Regression: the two default-rollback rejections must carry stable machine
  // `code`s parallel to the explicit-id `not_found` path, so release automation
  // can distinguish empty history from a single-release repo without scraping.
  it('empty history → no_releases code', () => {
    expect(pickPreviousRelease([])).toEqual({
      error: expect.stringContaining('No releases recorded yet'),
      code: 'no_releases',
    })
  })

  it('exactly one release → no_previous_release code', () => {
    expect(pickPreviousRelease([{ id: 'rel_1' }])).toEqual({
      error: expect.stringContaining('Only one release exists'),
      code: 'no_previous_release',
    })
  })

  it('two+ releases → the previous release id, no error', () => {
    expect(pickPreviousRelease([{ id: 'rel_current' }, { id: 'rel_prev' }])).toEqual({
      releaseId: 'rel_prev',
    })
  })
})

describe('unavailableDoGuardRefusal', () => {
  it('does not turn a judgment-dependent outage into a mandatory retry loop', () => {
    const refusal = unavailableDoGuardRefusal('Could not verify live classes.')

    expect(refusal).toMatchObject({
      code: 'do_guard_unavailable',
      action: undefined,
      actionRequired: false,
    })
    expect(refusal.message).toContain('--allow-do-deletion')
  })
})

describe('rollback consent gate', () => {
  // AX S2 (docs/audits/2026-09-01): a bare `deepspace rollback` probe
  // silently rolled production back, while undeploy demanded consent.
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    process.exitCode = undefined
  })

  it('refuses confirmation_required under --json without --yes, before any mutation', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    const releaseId = `rel_${'0'.repeat(26)}`
    const command = rollback as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { release: releaseId, json: true } })

    expect(JSON.parse(lines[0]!)).toMatchObject({
      ok: false,
      code: 'confirmation_required',
      appId: 'app_01HZXYABCDEFGHJKMNPQRSTVWX',
      releaseId,
    })
    expect(process.exitCode).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
