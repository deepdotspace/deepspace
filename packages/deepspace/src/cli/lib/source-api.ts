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
  return new Refusal(
    `This app uses GitHub source (${repository}). Use normal Git/GitHub for source operations ` +
      '(clone, fetch, push); `deepspace deploy` ships the local working tree without changing Git.',
    'source_managed_by_github',
    { extra: { appId, repository } },
  )
}

/**
 * The INFERRED twin of {@link githubSourceRefusal}, for apps that are not
 * claimed as anything: their releases record GitHub, so an empty DeepSpace
 * cloud repo is not "push first" — it is "the source lives on GitHub". The
 * v0.26.0 AX pass caught `pull`, `clone`, and `workspace new`
 * all prescribing `deepspace push` here, which is the PERMANENT DeepSpace
 * claim: three verbs steering GitHub users through a one-way door. Same code
 * as the claimed refusal, so parsers need no new case; the sentence carries
 * the one fact that changes the decision — pushing claims, permanently.
 */
export function githubInferredRefusal(appId: string, repository: string): Refusal {
  return new Refusal(
    `This app ships from GitHub (${repository}) — inferred from its releases; ` +
      'its DeepSpace cloud repo is intentionally empty. Use normal Git/GitHub for source ' +
      'operations. (`deepspace push` would permanently claim DeepSpace source for this app — ' +
      'only run it to adopt DeepSpace source on purpose.)',
    'source_managed_by_github',
    { extra: { appId, repository, inferred: true } },
  )
}

/**
 * The repository an UNCLAIMED app's GitHub inference points at, or null when
 * nothing does. Evidence is the RELEASE LEDGER only — the latest release's
 * recorded source. Deliberately not the checkout's remotes: with no releases
 * at all there is no evidence the app "ships from GitHub", and a real
 * DeepSpace app whose owner merely keeps a GitHub mirror must not be refused
 * its first `pull`/`workspace new` on the strength of a remote name. One
 * bounded read, only ever consulted on refusal paths — never the happy path.
 */
export async function inferredGitHubRepository(
  deployUrl: string,
  token: string,
  appId: string,
): Promise<string | null> {
  try {
    // Dynamic: repo-api imports this module's refusal, so a static import
    // back at it would cycle.
    const { repoApi } = await import('./repo-api')
    const { release } = await repoApi(deployUrl, token, appId).latestRelease()
    if (release?.source?.provider === 'github') return release.source.repository
  } catch {
    // No release ledger to consult: no evidence.
  }
  return null
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
