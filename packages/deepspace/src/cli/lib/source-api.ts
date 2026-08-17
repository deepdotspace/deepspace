import { apiFetch, ApiError } from './api'
import type { GitRef } from './source-control'

export type AppSource = { provider: 'deepspace' } | { provider: 'github'; repository: string }

export interface AppSourceState {
  appId: string
  source: AppSource | null
  revision: number
  registered: boolean
  /**
   * The app's live subdomain host, or null when it has never been deployed.
   * `deploy` compares it against the wrangler `name` to settle a rename BEFORE
   * it builds. Absent from a platform older than this field.
   */
  registeredHost?: string | null
  /**
   * Present only when the caller is NOT the app's owner: whether the live
   * version carries the APP_OWNER_JWT an on-behalf deploy has to inherit.
   * Absent when the platform could not determine it (or predates the field) —
   * treat absence as unknown and let the commit-time guard answer.
   */
  onBehalf?: { ownerJwtLive: boolean }
}

export interface AppSourceChangeResult {
  appId: string
  source: AppSource
  revision: number
}

export async function getAppSource(
  deployUrl: string,
  token: string,
  appId: string,
): Promise<AppSourceState> {
  try {
    const state = await apiFetch<Omit<AppSourceState, 'registered'>>(
      deployUrl,
      token,
      `/api/apps/${encodeURIComponent(appId)}/source`,
    )
    return { ...state, registered: true }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'app_not_found') {
      return { appId, source: null, revision: 0, registered: false }
    }
    throw error
  }
}

export function setAppSource(
  deployUrl: string,
  token: string,
  appId: string,
  input: {
    source: AppSource
    expectedRevision: number
    branch?: string
    commitOid?: string
    refs?: GitRef[]
    expectedReleaseId?: string | null
    expectedReleaseCommitOid?: string | null
  },
): Promise<AppSourceChangeResult> {
  return apiFetch<AppSourceChangeResult>(
    deployUrl,
    token,
    `/api/apps/${encodeURIComponent(appId)}/source`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}
