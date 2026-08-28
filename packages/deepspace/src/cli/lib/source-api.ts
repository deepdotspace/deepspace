import { apiFetchReadWithRetry, ApiError } from './api'
import { Refusal } from './command'

export type AppSource = { provider: 'deepspace' } | { provider: 'github'; repository: string }

/**
 * THE GitHub-source refusal, for every source verb. `push` reaches it from its
 * own `/source` read, `pull`/`clone`/`workspace` from the repo API's 422 — one
 * sentence and one set of machine fields either way, so an agent's parser never
 * has to special-case which verb it ran (it used to get `appId`/`repository`
 * from `push` and prose-only from the other two).
 *
 * Deliberately no executable `action`: which command comes next depends on
 * whether the caller wanted to clone, fetch or push, and the CLI knows only
 * `owner/repo` — never the clone URL's protocol — so any `git clone` it printed
 * would be a guess.
 */
export function githubSourceRefusal(appId: string, repository: string): Refusal {
  // Byte-identical to the server's 422 sentence (deploy-worker repoAccess):
  // one refusal code must read as ONE refusal whichever side raised it
  // (2026-08-28 github AX F2 caught the two wordings drifting).
  return new Refusal(
    `This app uses GitHub source (${repository}). Use normal Git/GitHub for source operations. ` +
      '`deepspace deploy` ships the local working tree without changing Git.',
    'source_managed_by_github',
    { extra: { appId, repository } },
  )
}

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

export async function getAppSource(
  deployUrl: string,
  token: string,
  appId: string,
): Promise<AppSourceState> {
  try {
    const state = await apiFetchReadWithRetry<Omit<AppSourceState, 'registered'>>(
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
