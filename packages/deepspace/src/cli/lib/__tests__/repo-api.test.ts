/**
 * repo-api response-shape guard: a wrong/broken service can answer HTTP 200 with
 * `{}`, an empty body (which apiFetch reads as `{}`), `null`, or an array. Left
 * unchecked those destructure to `undefined` in the caller and surface as a false
 * `ok:true` or an uncoded `reading '…' of undefined` crash. Every repo-API read
 * that documents a required top-level field must instead reject the malformed 2xx
 * with a stable `invalid_response` code. A field that is present but null (e.g.
 * latestRelease's `release`) or an empty array is a valid shape.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { releaseSourceLabel, repoApi } from '../repo-api'
import { ApiError } from '../api'
import { Refusal } from '../command'
import { githubSourceRefusal } from '../source-api'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stub200(body: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  )
}

const api = () => repoApi('https://deploy.test', 'tok', 'app_01ARZ3NDEKTSV4RRFFQ69G5FAV')

describe('the router-404 version-skew slug', () => {
  // The worker's notFound handler answers JSON `{"error":"Not found"}` with no
  // `code` — the signal every version-skew fallback keys on. It must classify
  // `unrecognized_service` in BOTH body shapes; matching only the plain-text
  // form downgrades the real router 404 to the generic `http_error`, which
  // every other 4xx also carries, so nothing can tell the cases apart.
  for (const [label, body] of [
    ['JSON', '{"error":"Not found"}'],
    ['plain-text', 'Not found'],
  ] as const) {
    it(`codes a bare ${label} router 404 as unrecognized_service`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body, { status: 404 })),
      )
      const err = await api()
        .listWorkspaces()
        .then(() => null)
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe('unrecognized_service')
    })
  }

  it('leaves a CODED 404 alone (a real refusal, not a missing route)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":"No such workspace","code":"workspace_not_found"}', {
            status: 404,
          }),
      ),
    )
    const err = await api()
      .getWorkspace('ws_01ARZ3NDEKTSV4RRFFQ69G5FAV')
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('workspace_not_found')
  })

  it('keeps the structured fields on the error, not just the sentence', async () => {
    // `ApiError.details` is what the failure envelope spreads into `--json`,
    // so a caller reads the numbers the API computed instead of parsing them
    // back out of the prose.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":"Too big","code":"repo_full","usedBytes":41943040}', {
            status: 413,
          }),
      ),
    )
    const err = (await api()
      .listWorkspaces()
      .catch((e: unknown) => e)) as ApiError
    expect(err.details).toEqual({ usedBytes: 41943040 })
  })
})

describe('listWorkspaces reports a capped page', () => {
  it('passes the server truncated flag through', async () => {
    // Without it a capped page is indistinguishable from the whole set, and a
    // caller reading "3 workspaces" cannot tell that a fourth exists.
    stub200('{"views":[],"truncated":true}')
    await expect(api().listWorkspaces({ limit: 3 })).resolves.toEqual({
      views: [],
      truncated: true,
    })
  })
})

describe('source-authority refusals', () => {
  it('preserves the app id on workspace list just like every other repo read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'Source is managed by GitHub',
              code: 'source_managed_by_github',
              repository: 'deepdotspace/example',
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )

    const err = await api()
      .listWorkspaces()
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Refusal)
    expect(err).toEqual(
      githubSourceRefusal('app_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'deepdotspace/example'),
    )
  })
})

describe('repo-api shape guard', () => {
  const badShapes: Record<string, string> = {
    'empty object': '{}',
    'empty body': '',
    'json null': 'null',
    'json array': '[]',
  }

  for (const [label, body] of Object.entries(badShapes)) {
    it(`codes a ${label} 2xx as invalid_response (listReleases)`, async () => {
      stub200(body)
      const err = (await api()
        .listReleases()
        .catch((e) => e)) as ApiError
      expect(err).toBeInstanceOf(ApiError)
      expect(err.code).toBe('invalid_response')
    })
  }

  it('rejects a body that omits the documented field even when it carries other keys', async () => {
    stub200('{"somethingElse":123}')
    const err = (await api()
      .listReleases()
      .catch((e) => e)) as ApiError
    expect(err.code).toBe('invalid_response')
  })

  it('rejects a null-valued array field — a list is never null (listReleases)', async () => {
    stub200('{"releases":null}')
    const err = (await api()
      .listReleases()
      .catch((e) => e)) as ApiError
    expect(err.code).toBe('invalid_response')
  })

  it('rejects a null-valued object field (getWorkspace → view: null)', async () => {
    stub200('{"view":null}')
    const err = (await api()
      .getWorkspace('ws_1')
      .catch((e) => e)) as ApiError
    expect(err.code).toBe('invalid_response')
  })

  it('rejects a partial multi-field body — activity omits cursor/hasMore', async () => {
    stub200('{"events":[]}')
    const err = (await api()
      .listActivity()
      .catch((e) => e)) as ApiError
    expect(err.code).toBe('invalid_response')
  })

  it('rejects an object field sent as an array (getWorkspace → view: [])', async () => {
    // apiFetch only inspects the top-level body, so a nested wrong-typed field is
    // the guard's job: `view` must be a non-null, non-array object.
    stub200('{"view":[]}')
    const err = (await api()
      .getWorkspace('ws_1')
      .catch((e) => e)) as ApiError
    expect(err.code).toBe('invalid_response')
  })

  it('accepts getRefs with a null `head` (nullable) but rejects an omitted `head`', async () => {
    stub200('{"refs":[],"head":null}')
    await expect(api().getRefs()).resolves.toEqual({ refs: [], head: null })
    stub200('{"refs":[]}')
    const err = (await api()
      .getRefs()
      .catch((e) => e)) as ApiError
    expect(err?.code).toBe('invalid_response')
  })

  it('rejects an array with a null entry (releases: [null])', async () => {
    stub200('{"releases":[null]}')
    const err = (await api()
      .listReleases()
      .catch((e) => e)) as ApiError
    expect(err.code).toBe('invalid_response')
  })

  it('rejects an empty object where an entity is required (createWorkspace → view: {})', async () => {
    stub200('{"view":{}}')
    const err = (await api()
      .createWorkspace({
        workspaceId: 'ws_1',
        task: 't',
        baseOid: 'a'.repeat(40),
        idempotencyKey: 'k',
      })
      .catch((e: unknown) => e)) as ApiError
    expect(err.code).toBe('invalid_response')
  })

  it('accepts a present-but-empty required field (releases: [])', async () => {
    stub200('{"releases":[]}')
    await expect(api().listReleases()).resolves.toEqual({ releases: [] })
  })

  it('accepts a populated array and a populated object (real contents pass)', async () => {
    stub200('{"releases":[{"id":"rel_1"}]}')
    await expect(api().listReleases()).resolves.toEqual({ releases: [{ id: 'rel_1' }] })
    stub200('{"view":{"workspaceId":"ws_1","status":"active"}}')
    await expect(api().getWorkspace('ws_1')).resolves.toEqual({
      view: { workspaceId: 'ws_1', status: 'active' },
    })
  })

  it('accepts an array of empty objects — the per-entry-content check is the deferred schema tail', async () => {
    // Boundary marker: `[null]` is rejected (crashes downstream) but `[{}]` is
    // NOT — rejecting a wrong-fielded entry would need per-endpoint schema (the
    // "schema-free frontier"). This locks in that deliberate half-guarantee.
    stub200('{"releases":[{}]}')
    await expect(api().listReleases()).resolves.toEqual({ releases: [{}] })
  })

  it('accepts a fully-shaped multi-field body (activity: events+cursor+hasMore)', async () => {
    stub200('{"events":[],"cursor":0,"hasMore":false}')
    await expect(api().listActivity()).resolves.toEqual({ events: [], cursor: 0, hasMore: false })
  })

  it('requests a race-free activity tail cursor explicitly', async () => {
    let requested = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requested = String(input)
        return new Response('{"events":[],"cursor":42,"hasMore":false}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    await expect(api().listActivity({ tail: true })).resolves.toMatchObject({ cursor: 42 })
    expect(new URL(requested).searchParams.get('tail')).toBe('1')
  })

  it('accepts a present-but-null NULLABLE field (latestRelease → release: null)', async () => {
    // `release` is documented as RemoteRelease | null (no releases yet) — a
    // presence-only field, unlike the non-null `view`/`releases` above.
    stub200('{"release":null}')
    await expect(api().latestRelease()).resolves.toEqual({ release: null })
  })
})

describe('a workspace is sanitised where it is parsed, not where it is printed', () => {
  const RLO = String.fromCodePoint(0x202e)
  const ESC = String.fromCodePoint(0x1b)
  const CR = String.fromCodePoint(0x0d)

  const view = (over: Record<string, unknown> = {}) => ({
    workspace: {
      id: 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      task: 'ship it',
      baseOid: 'a'.repeat(40),
      ref: 'refs/deepspace/ws/ws_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'active',
      createdBy: 'usr_1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      landedOid: null,
      ...over,
    },
    tipOid: null,
    aheadOfBase: null,
    behindTrunk: null,
  })

  it('escapes a peer-authored task on every workspace read', async () => {
    // The task crosses seats: one agent writes it, another's `workspace
    // list`/`attach`/`status` prints it. Escaping at the six print sites is
    // what kept failing, so it happens once, here.
    const hostile = `ship ${RLO}${ESC}[2K${CR}FAKE`
    stub200(JSON.stringify({ views: [view({ task: hostile })] }))
    const listed = await api().listWorkspaces()
    const task = listed.views[0].workspace.task
    expect(task).not.toContain(RLO)
    expect(task).not.toContain(ESC)
    expect(task).not.toContain(CR)
    expect(task).toContain('FAKE')

    // …and on the single-view endpoints, which are separate calls.
    stub200(JSON.stringify({ view: view({ task: hostile }) }))
    const one = await api().getWorkspace('ws_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(one.view.workspace.task).not.toContain(RLO)
  })

  it('leaves an ordinary task exactly as written', async () => {
    stub200(JSON.stringify({ view: view({ task: 'ship 日本語 😀 fix' }) }))
    const one = await api().getWorkspace('ws_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(one.view.workspace.task).toBe('ship 日本語 😀 fix')
  })

  it('refuses a workspace ref the server does not own', async () => {
    // The ref reaches git argv and emitted `action.argv`. It is validated,
    // not escaped: a server answering with another shape is broken, and there
    // is no rendering fix for that.
    for (const ref of [
      'refs/heads/main',
      '--upload-pack=touch /tmp/pwned',
      'refs/deepspace/ws/../../heads/main',
      'refs/deepspace/ws/not-a-ulid',
      '',
    ]) {
      stub200(JSON.stringify({ view: view({ ref }) }))
      const err = (await api()
        .getWorkspace('ws_01ARZ3NDEKTSV4RRFFQ69G5FAV')
        .catch((e: unknown) => e)) as ApiError
      expect(err, ref).toBeInstanceOf(ApiError)
      expect(err.code, ref).toBe('invalid_response')
    }
  })

  it('accepts the ref shape the server does own', async () => {
    stub200(JSON.stringify({ view: view() }))
    await expect(api().getWorkspace('ws_01ARZ3NDEKTSV4RRFFQ69G5FAV')).resolves.toBeTruthy()
  })
})

describe('the GitHub-source refusal is one refusal', () => {
  const APP = 'app_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const REPOSITORY = 'donalddellapietra/changelog-c4'

  function stub422() {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: `This app uses GitHub source (${REPOSITORY}). Use normal Git/GitHub for source operations. \`deepspace deploy\` ships the local working tree without changing Git.`,
              code: 'source_managed_by_github',
              repository: REPOSITORY,
            }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
  }

  it('translates the repo API 422 — the read `pull`/`clone` both start with — into it', async () => {
    // `pull` and `clone` used to surface the server's ApiError verbatim, so
    // their envelopes named the repository only in prose while `push` (which
    // refuses from its own /source read) carried `appId`/`repository` as
    // fields. An agent's parser had to special-case two of three sibling verbs.
    stub422()
    const err = (await api()
      .getRefs()
      .catch((e) => e)) as Refusal
    expect(err).toBeInstanceOf(Refusal)
    expect(err.code).toBe('source_managed_by_github')
    expect(err.extra).toEqual({ appId: APP, repository: REPOSITORY })
    // No executable action: which command comes next depends on whether the
    // caller wanted to clone, fetch or push, and the CLI holds `owner/repo`,
    // never the clone URL's protocol.
    expect(err.action).toBeUndefined()
  })

  it('is byte-identical to the one `push` raises from its own /source read', async () => {
    stub422()
    const fromRepoApi = (await api()
      .getRefs()
      .catch((e) => e)) as Refusal
    const fromPush = githubSourceRefusal(APP, REPOSITORY)
    expect(fromRepoApi.message).toBe(fromPush.message)
    expect(fromRepoApi.code).toBe(fromPush.code)
    expect(fromRepoApi.extra).toEqual(fromPush.extra)
    expect(fromRepoApi.message).toContain(REPOSITORY)
  })

  it('keeps the server ApiError when the 422 names no repository to unify on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'This app uses GitHub source.',
              code: 'source_managed_by_github',
            }),
            { status: 422, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    const err = (await api()
      .getRefs()
      .catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('source_managed_by_github')
  })

  it('keeps every other field a server refusal computed, instead of dropping it into prose', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'Storage limit reached.',
              code: 'storage_limit',
              usedBytes: 12,
              limitBytes: 10,
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    const err = (await api()
      .getRefs()
      .catch((e) => e)) as ApiError
    expect(err.details).toEqual({ usedBytes: 12, limitBytes: 10 })
  })
})

describe('releaseSourceLabel', () => {
  // A GitHub-source release records NO commit — deploy ships the working tree
  // without touching Git — so `releases`, `status`'s Live line and `activity`
  // each rendered it as "(no source recorded)" / "unknown source" / "?", two
  // lines under a `Source  GitHub · owner/repo` line and contradicting the
  // `source` the same release carries in --json. Three passes, one formatter.
  it('names the source when the release records one but no commit', () => {
    expect(
      releaseSourceLabel({
        commitOid: null,
        source: { provider: 'github', repository: 'donalddellapietra/changelog-c4' },
      }),
    ).toBe('GitHub · donalddellapietra/changelog-c4')
    expect(releaseSourceLabel({ commitOid: null, source: { provider: 'deepspace' } })).toBe(
      'DeepSpace source, no commit recorded',
    )
  })

  it('still prefers the commit, and still admits when there is nothing at all', () => {
    expect(
      releaseSourceLabel({ commitOid: 'd47e3551eb9c0f', source: { provider: 'deepspace' } }),
    ).toBe('commit d47e3551eb')
    expect(releaseSourceLabel({ commitOid: null, source: null })).toBe('no source recorded')
  })
})
