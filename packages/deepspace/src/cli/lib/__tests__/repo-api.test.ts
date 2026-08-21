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
            JSON.stringify({ error: 'This app uses GitHub source.', code: 'source_managed_by_github' }),
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
