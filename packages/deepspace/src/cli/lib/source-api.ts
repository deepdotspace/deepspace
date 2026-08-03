import { apiFetch, ApiError } from './api'
import type { GitRef } from './source-control'

export type AppSource = { provider: 'deepspace' } | { provider: 'github'; repository: string }

export interface AppSourceState {
  appId: string
  source: AppSource | null
  revision: number
  registered: boolean
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
