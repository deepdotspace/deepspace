/**
 * Typed client for the deploy-worker's /api/repo JSON surface — the DeepSpace
 * layer on top of the git remote: refs for scripting, workspaces, the activity
 * feed, and the release history. Object transfer itself never goes through
 * here; that's real git against the smart-HTTP endpoint (lib/vc-remote.ts).
 *
 * Idempotency: `createWorkspace` carries a client-minted key, so a retried
 * create replays the recorded outcome instead of double-writing. sync, land
 * and drop are idempotent by CONSTRUCTION instead — each is a state
 * transition whose replay is a no-op (same tip, already-landed, already-
 * dropped all return the current view) — so they send no key.
 */

import { randomUUID } from 'node:crypto'
import { apiFetch, ApiError } from './api'

export interface RemoteRef {
  name: string
  oid: string
  updatedAt: string
  updatedBy: string
}

export interface RemoteRefsResult {
  refs: RemoteRef[]
  head: string | null
}

export interface RemoteRelease {
  id: string
  seq: number
  commitOid: string | null
  cfVersionId: string | null
  rollbackAvailable: boolean
  config: unknown
  actor: string
  url: string | null
  kind: 'deploy' | 'rollback'
  createdAt: string
}

export interface RemoteWorkspace {
  id: string
  task: string
  baseOid: string
  ref: string
  status: 'active' | 'landed' | 'dropped'
  createdBy: string
  createdAt: string
  updatedAt: string
  landedOid: string | null
}

export interface RemoteCommitCount {
  count: number
  capped: boolean
}

/** Commit-graph facts the repo DO owns. Path-level coordination (which other
 *  workspaces touch the same files) is computed client-side from local diffs —
 *  see `workspace.ts`. */
export interface RemoteWorkspaceView {
  workspace: RemoteWorkspace
  tipOid: string | null
  aheadOfBase: RemoteCommitCount | null
  behindTrunk: RemoteCommitCount | null
}

export interface RemoteActivityEvent {
  seq: number
  kind: string
  subjectId: string | null
  summary: unknown
  actor: string
  createdAt: string
}

export function mintIdempotencyKey(): string {
  return randomUUID()
}

/**
 * Resolve a live subdomain name to its app id via the deploy worker's
 * access-gated resolver (`GET /api/repo/resolve-name/:name`). Unlike the
 * owner-only `/api/apps` list, this also finds apps the caller merely
 * COLLABORATES on. Returns null when the name is unknown, malformed, or the
 * caller has no access — the server deliberately doesn't distinguish the
 * first from the last (no existence oracle).
 */
export async function resolveAppIdByName(
  deployUrl: string,
  token: string,
  name: string,
): Promise<string | null> {
  try {
    const { appId } = await apiFetch<{ appId: string }>(
      deployUrl,
      token,
      `/api/repo/resolve-name/${encodeURIComponent(name)}`,
    )
    return appId ?? null
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null
    throw err
  }
}

export function repoApi(deployUrl: string, token: string, appId: string) {
  const base = `/api/repo/${encodeURIComponent(appId)}`
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    // The bare-404 "wrong/old service" case (→ unrecognized_service) is handled
    // uniformly in apiFetch now, for every caller incl. rollback's direct endpoint.
    return await apiFetch<T>(deployUrl, token, `${base}${path}`, init)
  }
  const post = <T>(path: string, body: unknown) =>
    call<T>(path, { method: 'POST', body: JSON.stringify(body) })

  // A well-formed repo-API 2xx body carries the endpoint's documented fields with
  // the right shape. A wrong/broken service can answer 200 with `{}` (or an empty
  // body, which apiFetch reads as `{}`), a null-valued field, or the wrong type;
  // left unchecked those destructure to `undefined`/`null` downstream and surface
  // as a false `ok:true` or an uncoded `reading '…' of null|undefined` crash. Code
  // such a body as invalid_response — the same slug apiFetch uses for a
  // null/array/non-JSON 2xx. This enforces every SCHEMA-FREE degeneracy check —
  // present, correct JSON type, non-null, arrays carry no null entries, objects
  // are non-empty — and stops exactly where a check would need the per-endpoint
  // field schema (a populated-but-wrong-fielded entity like `{view:{wrong:1}}` or
  // `[{}]` is left to the caller's TS types + happy-path tests, NOT re-validated
  // here). Kinds: `array` (a list, never null, no null entries), `object` (a
  // non-empty, non-null, non-array object — a real entity is never `{}`, and no
  // top-level field is a legitimately-empty map; do NOT tag such a field `object`
  // if one is ever added), `present` (key exists; value may be null — e.g. a
  // nullable ref like getRefs' `head`).
  const KIND = {
    array: (v: unknown) => Array.isArray(v) && v.every((e) => e !== null),
    object: (v: unknown) =>
      v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0,
    present: (v: unknown) => v !== undefined,
  }
  type Kind = keyof typeof KIND
  const shapeError = (path: string) =>
    new ApiError(
      `The deploy service at ${deployUrl} returned an unexpected response shape — check DEEPSPACE_DEPLOY_URL (is this the service the app lives on?).`,
      200,
      'invalid_response',
      `${base}${path}`,
    )
  // Each `spec` key must name a documented top-level field of the response (a
  // typo'd key rejects every valid 2xx as invalid_response — fail-loud, caught by
  // the per-endpoint happy-path tests). Keys stay strings (not `keyof T`) so T
  // still infers from each method's return annotation rather than from the spec.
  const assertShape = <T>(r: T, spec: Record<string, Kind>, path: string): T => {
    if (r === null || typeof r !== 'object') throw shapeError(path)
    const obj = r as Record<string, unknown>
    for (const [key, kind] of Object.entries(spec)) {
      if (!KIND[kind](obj[key])) throw shapeError(path)
    }
    return r
  }
  const getShape = async <T>(path: string, spec: Record<string, Kind>): Promise<T> =>
    assertShape(await call<T>(path), spec, path)
  const postShape = async <T>(
    path: string,
    body: unknown,
    spec: Record<string, Kind>,
  ): Promise<T> => assertShape(await post<T>(path, body), spec, path)

  return {
    /** null ⇒ the app has never been registered (fresh repo, no history). */
    async getRefs(): Promise<RemoteRefsResult | null> {
      try {
        return await getShape<RemoteRefsResult>('/refs', { refs: 'array', head: 'present' })
      } catch (err) {
        if (err instanceof ApiError && err.code === 'app_not_found') return null
        throw err
      }
    },

    createWorkspace(args: {
      workspaceId: string
      task: string
      baseOid: string
      idempotencyKey: string
    }): Promise<{ view: RemoteWorkspaceView }> {
      return postShape('/workspaces', args, { view: 'object' })
    },

    listWorkspaces(opts?: {
      all?: boolean
      limit?: number
    }): Promise<{ views: RemoteWorkspaceView[] }> {
      const params = new URLSearchParams()
      if (opts?.all) params.set('all', '1')
      if (opts?.limit) params.set('limit', String(opts.limit))
      const qs = params.toString()
      return getShape(`/workspaces${qs ? `?${qs}` : ''}`, { views: 'array' })
    },

    getWorkspace(id: string): Promise<{ view: RemoteWorkspaceView }> {
      return getShape(`/workspaces/${encodeURIComponent(id)}`, { view: 'object' })
    },

    syncWorkspace(id: string, args: { headOid: string }): Promise<{ view: RemoteWorkspaceView }> {
      return postShape(`/workspaces/${encodeURIComponent(id)}/sync`, args, { view: 'object' })
    },

    landWorkspace(
      id: string,
      args: { landedOid: string; intoRef?: string },
    ): Promise<{ view: RemoteWorkspaceView }> {
      return postShape(`/workspaces/${encodeURIComponent(id)}/land`, args, { view: 'object' })
    },

    dropWorkspace(id: string): Promise<{ view: RemoteWorkspaceView }> {
      return postShape(`/workspaces/${encodeURIComponent(id)}/drop`, {}, { view: 'object' })
    },

    listActivity(opts?: {
      since?: number
      limit?: number
      tail?: boolean
    }): Promise<{ events: RemoteActivityEvent[]; cursor: number; hasMore: boolean }> {
      const params = new URLSearchParams()
      if (opts?.since) params.set('since', String(opts.since))
      if (opts?.limit) params.set('limit', String(opts.limit))
      if (opts?.tail) params.set('tail', '1')
      const qs = params.toString()
      return getShape(`/activity${qs ? `?${qs}` : ''}`, {
        events: 'array',
        cursor: 'present',
        hasMore: 'present',
      })
    },

    listReleases(limit?: number): Promise<{ releases: RemoteRelease[] }> {
      return getShape(`/releases${limit ? `?limit=${limit}` : ''}`, { releases: 'array' })
    },

    latestRelease(): Promise<{ release: RemoteRelease | null }> {
      // `release` is nullable (no releases yet) — presence-only, not `object`.
      return getShape('/releases/latest', { release: 'present' })
    },

    getRelease(id: string): Promise<{ release: RemoteRelease }> {
      return getShape(`/releases/${encodeURIComponent(id)}`, { release: 'object' })
    },
  }
}

export type RepoApi = ReturnType<typeof repoApi>
