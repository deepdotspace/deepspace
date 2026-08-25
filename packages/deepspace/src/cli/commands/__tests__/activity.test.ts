import { afterEach, describe, expect, it, vi } from 'vitest'
import activity, { formatEvent, landIndex } from '../activity'
import type { RemoteActivityEvent } from '../../lib/repo-api'
import * as authModule from '../../auth'
import * as appTargetModule from '../../lib/app-target'
import * as actorLabelsModule from '../../lib/actor-labels'
import * as repoApiModule from '../../lib/repo-api'

const ev = (partial: Partial<RemoteActivityEvent>): RemoteActivityEvent => ({
  seq: 1,
  kind: 'push',
  subjectId: null,
  summary: null,
  actor: 'u',
  createdAt: '2026-07-24T00:00:00.000Z',
  ...partial,
})

const OID = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

afterEach(() => {
  vi.restoreAllMocks()
  // The runtime records exit codes on process.exitCode now; clear it so a
  // refusal-path test cannot poison the vitest worker's own exit code.
  process.exitCode = undefined
})

describe('landIndex + formatEvent land labeling', () => {
  const landed = ev({
    seq: 2,
    kind: 'workspace.landed',
    subjectId: 'ws_01TEST',
    summary: { task: 't', landedOid: OID, into: 'main' },
  })
  const landPush = ev({
    seq: 1,
    summary: { refs: [{ ref: 'refs/heads/main', newOid: OID }] },
  })
  const unrelatedPush = ev({
    seq: 3,
    summary: { refs: [{ ref: 'refs/heads/main', newOid: OTHER }] },
  })

  it('labels a trunk push whose oid matches a landed event in the page', () => {
    const lands = landIndex([landPush, landed, unrelatedPush])
    expect(formatEvent(landPush, lands)).toContain('(land of ws_01TEST)')
    expect(formatEvent(unrelatedPush, lands)).not.toContain('land of')
  })

  it('is inert without the index and skips landed events missing a subject', () => {
    expect(formatEvent(landPush)).not.toContain('land of')
    const noSubject = { ...landed, subjectId: null }
    expect(landIndex([landPush, noSubject]).size).toBe(0)
  })

  it('resolves actor ids through the labels map, falling back to the raw id', () => {
    const actors = new Map([['u', 'dev@example.com (you)']])
    expect(formatEvent(landPush, undefined, actors)).toContain('dev@example.com (you)')
    expect(formatEvent(landPush, undefined, new Map())).toContain('  u  ')
  })

  it('renders an unknown event kind as a plain line instead of crashing', () => {
    const unknown = ev({ seq: 5, kind: 'some.future.kind', summary: { x: 1 } })
    expect(formatEvent(unknown)).toContain('some.future.kind')
  })

  it('reads the all-zero oid as a DELETION, not a commit tip', () => {
    // git's deletion sentinel. Rendered as a tip it printed
    // "feature/x → 0000000000", which reads as a push TO that oid.
    const deletion = ev({
      seq: 6,
      summary: { refs: [{ ref: 'refs/heads/feature/x', newOid: '0'.repeat(40) }] },
    })
    expect(formatEvent(deletion)).toContain('deleted feature/x')
    expect(formatEvent(deletion)).not.toContain('→')

    // A normal push is unaffected.
    expect(formatEvent(landPush)).toContain('main → ')
  })
})

describe('activity --since/--limit validation fires before any network', () => {
  // The cursor/limit parse was moved to the top of run(), ahead of ensureToken/
  // resolveAppTarget, so malformed input is rejected without an auth/network
  // round-trip. These drive run() with no network mocks: if the guard were
  // removed, control would reach ensureToken (unmocked) and emit some OTHER
  // code, so `.find` on the expected code would return undefined and fail.
  const cmd = activity as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }
  const drive = async (args: Record<string, unknown>) => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(((s?: unknown) => {
      logs.push(String(s))
    }) as never)
    const errSpy = vi.spyOn(console, 'error').mockImplementation((() => {}) as never)
    process.exitCode = undefined
    try {
      await cmd.run({ args })
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
    }
    // The runtime records the code instead of calling process.exit.
    return { logs, exits: [process.exitCode] as Array<number | undefined> }
  }

  it('rejects a fractional --since with invalid_cursor (the flagship malformed-cursor case)', async () => {
    const { logs, exits } = await drive({ since: '1.9', json: true })
    const out = logs.map((l) => JSON.parse(l)).find((o) => o.code === 'invalid_cursor')
    expect(out).toMatchObject({ ok: false, code: 'invalid_cursor' })
    expect(exits[0]).toBe(1)
  })

  it('rejects a non-numeric --limit with invalid_limit', async () => {
    const { logs, exits } = await drive({ limit: 'nope', json: true })
    const out = logs.map((l) => JSON.parse(l)).find((o) => o.code === 'invalid_limit')
    expect(out).toMatchObject({ ok: false, code: 'invalid_limit' })
    expect(exits[0]).toBe(1)
  })
})

describe('one-shot activity pagination', () => {
  it('returns one bounded page in human mode instead of draining hasMore', async () => {
    const listActivity = vi
      .fn()
      .mockResolvedValueOnce({ events: [ev({})], cursor: 1, hasMore: true })
      .mockResolvedValueOnce({ events: [ev({ seq: 2 })], cursor: 2, hasMore: false })
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(
      'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
    )
    vi.spyOn(actorLabelsModule, 'actorLabels').mockResolvedValue(new Map())
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({ listActivity } as never)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    const cmd = activity as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await cmd.run({
      args: {
        app: 'app_01ABCDEFGHJKMNPQRSTVWXYZ00',
        follow: false,
        json: false,
        limit: '1',
        since: '0',
      },
    })
    expect(process.exitCode).toBe(0)
    expect(listActivity).toHaveBeenCalledTimes(1)
  })
})

describe('a GitHub-source release in the feed', () => {
  it('names its repository instead of the bare `?` a null commitOid printed', () => {
    // The feed event carries `sourceProvider`/`sourceRepository` exactly as the
    // release row does; only the human rendering keyed on `commitOid === null`,
    // so `activity` printed `#3 ?` for a release whose --json records its
    // source — the same break `releases` and `status` had.
    const line = formatEvent(
      ev({
        seq: 3,
        kind: 'release.deploy',
        summary: {
          seq: 3,
          commitOid: null,
          sourceProvider: 'github',
          sourceRepository: 'donalddellapietra/changelog-c4',
        },
      }),
    )
    expect(line).toContain('#3 GitHub · donalddellapietra/changelog-c4')
    expect(line).not.toContain('?')
  })

  it('still prints the commit when the release recorded one', () => {
    const line = formatEvent(
      ev({
        seq: 4,
        kind: 'release.deploy',
        summary: { seq: 4, commitOid: OID, sourceProvider: 'deepspace' },
      }),
    )
    expect(line).toContain(`#4 commit ${OID.slice(0, 10)}`)
  })
})
