/**
 * `deepspace status` — one screenful of present-tense truth, so an agent
 * re-orients from a single command after any context loss instead of
 * reconstructing state from five reads and memory.
 *
 * State, not story: session, app, deps, branch/workspace position, live
 * and release. No narrative, no summarization — interpretation is the agent's
 * job. Recovery commands belong to the operation that refuses, not to a
 * centralized cross-product of every possible status fact. Live coordination
 * facts stream separately through `deepspace activity --follow`.
 *
 * Network sections are fetched in parallel and degrade PER LINE to
 * `(unreachable)` — status must never fail to report the local facts it has.
 * Informational throughout: exit 0 whenever the report itself was produced.
 */

import { defineCommand } from 'citty'
import { displayLines } from '../lib/cli-format'
import * as p from '@clack/prompts'
import { existsSync, readFileSync } from 'node:fs'
import { SESSION_PATH, TOKEN_PATH, ensureToken } from '../auth'
import { DEEPSPACE_ENV, effectivePlatformUrls } from '../env'
import { decodeJwtPayload } from '../../shared/jwt'
import { findAppDir, detectAppName } from '../lib/app-context'
import { readAppId } from '../lib/app-identity'
import { currentBranch, isAncestor, resolveCommit } from '../lib/git/repository'
import { statusFiles } from '../lib/git/safety'
import { workspaceIdFromBranch } from '../lib/workspace-id'
import { deployBaseUrl } from '../lib/vc-remote'
import {
  releaseSourceLabel,
  repoApi,
  type RemoteRelease,
  type RemoteWorkspaceView,
} from '../lib/repo-api'
import { errorCode } from '../lib/cli-errors'
import { externalGitSource } from './deploy/repository'
import { installState } from '../lib/install-status'
import { installCommand } from '../lib/package-manager'
import { createSpinner } from '../lib/spinner'
import { InputError } from '../lib/cli-errors'
import { readWranglerConfig, resolveAppNameForEnv } from '../lib/wrangler-env'
import { getAppSource } from '../lib/source-api'
import { parseWranglerEnvArg, listApps, liveAppUrl, type AppListEntry } from '../lib/app-target'

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return iso
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const UNREACHABLE = '(unreachable)'

/** An unusable session, in the shape every other unavailability in this file
 *  reports — so a consumer branching on `code` (per the contract) sees one
 *  thing whether the session was never there or has expired. */
const sessionError = (error: string) =>
  ({ state: 'unavailable', error, code: 'not_authenticated' }) as const

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

const observeRemote = <T>(promise: Promise<T>): Promise<RemoteResult<T>> =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  )

export function statusRemoteFailure(error: unknown): {
  human: string
  json: { state: 'unavailable'; error: string; code?: string }
} {
  const message = error instanceof Error ? error.message : String(error)
  const code = errorCode(error)
  const suffix = code ? ` [${code}]` : ''
  return {
    human:
      code === 'network_error' ? `${UNREACHABLE} — ${message}${suffix}` : `${message}${suffix}`,
    json: { state: 'unavailable', error: message, ...(code ? { code } : {}) },
  }
}

export function resolveStatusApp(
  appDir: string,
  wranglerEnv?: string,
): { appName: string; appId: string | null; appIdError?: string } {
  let appName: string
  if (!wranglerEnv) {
    appName = detectAppName(appDir) ?? '(unnamed)'
  } else {
    const resolved = resolveAppNameForEnv(readWranglerConfig(appDir), wranglerEnv)
    if (!resolved.ok) throw new InputError(resolved.reason, 'invalid_env')
    appName = resolved.name
  }
  // `status` is the command you run to find out what is wrong, so a
  // malformed id (`invalid_app_id` from readAppId) is the App line's
  // diagnostic, not the end of the report.
  try {
    return { appName, appId: readAppId(appDir, wranglerEnv) }
  } catch (err) {
    if ((err as { code?: string }).code !== 'invalid_app_id') throw err
    return { appName, appId: null, appIdError: (err as Error).message }
  }
}

export default defineCommand({
  meta: {
    name: 'status',
    description:
      'One screenful of current state — always names the platform plane (env, services) — plus session, app, workspace, and live release',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit a single-line JSON result for scripts/agents',
      default: false,
    },
    env: {
      type: 'string',
      alias: 'e',
      description: 'wrangler.toml [env.<name>] slot — reads that environment’s app identity',
      required: false,
    },
  },
  async run({ args }) {
    const { wranglerEnv, error: envError } = parseWranglerEnvArg(args.env)
    if (envError) throw new InputError(envError, 'invalid_env')
    const lines: Array<[string, string]> = []
    const facts = {
      loggedIn: false,
      workspaceId: null as string | null,
      dirtyFiles: 0,
      unsynced: false,
      aheadOfBase: 0,
      trunkState: 'unknown' as
        | 'in_sync'
        | 'local_ahead'
        | 'local_behind'
        | 'diverged'
        | 'differs'
        | 'unknown',
    }
    const json: Record<string, unknown> = { ok: true }

    // ── environment — always. "Which plane am I about to mutate?" is the
    // first thing an agent has to know, and production is the answer that
    // matters most, so it is never elided. Service URLs are listed only when
    // they are not the plain preset (staging, or a per-service override).
    const urlOverrides = [
      'DEEPSPACE_DEPLOY_URL',
      'DEEPSPACE_AUTH_URL',
      'DEEPSPACE_API_URL',
      'DEEPSPACE_PLATFORM_URL',
    ].filter((k) => process.env[k])
    const urls = effectivePlatformUrls()
    lines.push([
      'Env',
      [DEEPSPACE_ENV, ...urlOverrides.map((k) => `${k} set`)].join(' · '),
    ])
    json.env = DEEPSPACE_ENV
    json.services = urls
    if (DEEPSPACE_ENV !== 'production' || urlOverrides.length > 0) {
      lines.push([
        'Services',
        `auth ${urls.auth} · api ${urls.api} · platform ${urls.platform} · deploy ${urls.deploy}`,
      ])
      if (urlOverrides.length > 0) json.urlOverrides = urlOverrides
    }

    // ── session (local only — never blocks on the network) ──────────────
    // EITHER file is a usable session: the rest of the CLI mints a token from
    // `session`, and `token` on its own is a live credential. Keying on
    // `session` alone contradicts `auth whoami` in both directions, and an
    // agent that reads `loggedIn: false` starts an interactive browser OAuth
    // nobody is there to complete.
    facts.loggedIn = existsSync(SESSION_PATH) || existsSync(TOKEN_PATH)
    let userId: string | null = null
    if (!facts.loggedIn) {
      lines.push(['Session', 'not logged in'])
      json.loggedIn = false
      json.sessionError = sessionError('Not logged in. Run `deepspace auth login` first.')
    } else {
      let who: string | null = null
      try {
        const payload = decodeJwtPayload<{ email?: string; sub?: string }>(
          readFileSync(TOKEN_PATH, 'utf-8').trim(),
        )
        if (payload.email) who = payload.email
        userId = payload.sub ?? null
      } catch {
        // token file absent/stale — the session still mints on next use
      }
      lines.push([
        'Session',
        `${who ?? 'logged in'} · renews on use (re-login only after 30 idle days)`,
      ])
      json.loggedIn = true
      // `user` is an email in every run that has an identity, so a placeholder
      // string there would silently fail an identity comparison. Omit the key
      // when the identity is genuinely unknown.
      if (who) json.user = who
    }

    // ── app (local) ──────────────────────────────────────────────────────
    const appDir = findAppDir()
    if (!appDir) {
      lines.push(['App', 'not inside a DeepSpace app directory'])
      json.inApp = false
    } else {
      const { appName, appId, appIdError } = resolveStatusApp(appDir, wranglerEnv)
      lines.push([
        'App',
        `${appName}${wranglerEnv ? ` [env.${wranglerEnv}]` : ''}${
          appId
            ? ` (${appId})`
            : appIdError
              ? ` — ${appIdError}`
              : ' — no DEEPSPACE_APP_ID yet; it registers on first use (deploy, secrets, dev…)'
        }`,
      ])
      json.inApp = true
      json.appName = appName
      json.appId = appId
      if (appIdError) json.appIdError = appIdError
      if (wranglerEnv) json.wranglerEnv = wranglerEnv

      const deps = installState(appDir)
      const depsInstallCommand = installCommand(appDir)
      lines.push([
        'Deps',
        deps === 'ready'
          ? 'installed'
          : deps === 'installing'
            ? 'dependency installation is still running'
            : deps === 'missing'
              ? 'missing — any command that needs them installs on first use'
              : `failed — retried automatically by the next dev/test/deploy (or run ${depsInstallCommand})`,
      ])
      json.deps = deps

      // ── local git position ────────────────────────────────────────────
      let branch: string | null = null
      try {
        branch = currentBranch(appDir)
        facts.dirtyFiles = statusFiles(appDir).length
        facts.workspaceId = workspaceIdFromBranch(branch)
        lines.push([
          'Branch',
          `${branch ?? '(detached)'}${facts.workspaceId ? ` → workspace ${facts.workspaceId}` : ''}`,
        ])
        lines.push([
          'Worktree',
          facts.dirtyFiles === 0
            ? 'clean'
            : `${facts.dirtyFiles} uncommitted file${facts.dirtyFiles === 1 ? '' : 's'}`,
        ])
        json.branch = branch
        json.workspaceId = facts.workspaceId
        json.dirtyFiles = facts.dirtyFiles
      } catch {
        lines.push(['Branch', 'not a git repository'])
        json.branch = null
      }

      // ── network facts, in parallel, each degrading alone ──────────────
      if (facts.loggedIn && appId) {
        const spinner = args.json ? null : createSpinner()
        spinner?.start('Checking cloud state…')
        let token: string | null = null
        try {
          token = await ensureToken()
        } catch (err) {
          // Offline is NOT a dead session. exchangeSession's fetch REJECTS
          // when the network is down, and reporting that as "expired" both
          // lies and obscures every local fact status already gathered. Only
          // a real auth failure clears loggedIn.
          const offline = err instanceof TypeError || errorCode(err) === 'network_error'
          if (offline) {
            lines.push(['Cloud', `${UNREACHABLE} — local facts only`])
            json.cloudUnreachable = true
          } else {
            lines.push(['Cloud', 'session expired — run `deepspace auth login`'])
            facts.loggedIn = false
            json.sessionExpired = true
            // An expired session is not logged in, and the identity read from
            // an expired token compares equal to a live one — so a consumer
            // asking "am I still acting as X" must not find `user` here. This
            // is the path where a session actually dies, so it carries the
            // same coded shape as the never-logged-in one.
            json.loggedIn = false
            delete json.user
            json.sessionError = sessionError('Session expired. Run `deepspace auth login`.')
          }
        }
        if (token) {
          const api = repoApi(deployBaseUrl(), token, appId)
          const sourceResult = await observeRemote(getAppSource(deployBaseUrl(), token, appId))
          const source = sourceResult.ok ? sourceResult.value.source : null
          const githubSource = source?.provider === 'github'
          if (!sourceResult.ok) {
            reportRemoteFailure('Source', 'source', sourceResult.error)
          } else if (githubSource) {
            lines.push(['Source', `GitHub · ${source.repository} (manual Git ownership)`])
            json.source = { ...source, revision: sourceResult.value.revision }
          } else if (source?.provider === 'deepspace') {
            lines.push([
              'Source',
              `DeepSpace · packaged Git (revision ${sourceResult.value.revision})`,
            ])
            json.source = { ...source, revision: sourceResult.value.revision }
          } else {
            // Inference, not a default: with a GitHub remote in the checkout
            // the next deploy ships as GitHub; without one it syncs to
            // DeepSpace (and that sync claims, permanently).
            const github = externalGitSource(appDir, null)
            lines.push([
              'Source',
              `unclaimed · ${
                github
                  ? 'next deploy infers GitHub from this checkout’s remote'
                  : 'next deploy syncs to DeepSpace and claims it, permanently'
              }`,
            ])
            json.source = null
            // The machine mirror of the prose above — `source: null` alone
            // would know less than the human line.
            json.sourceInference = github ? 'github' : 'deepspace'
          }
          const [refsResult, wsResult, releaseResult, appsResult] = await Promise.all([
            githubSource
              ? Promise.resolve({ ok: true, value: null } as const)
              : observeRemote(api.getRefs()),
            facts.workspaceId && !githubSource
              ? observeRemote(api.getWorkspace(facts.workspaceId).then((r) => r.view))
              : Promise.resolve({ ok: true, value: null } as const),
            observeRemote(api.latestRelease().then((r) => r.release)),
            observeRemote(listApps(deployBaseUrl(), token)),
          ] as const)

          // workspace position
          if (facts.workspaceId) {
            if (githubSource) {
              lines.push(['Workspace', 'DeepSpace workspaces are disabled for GitHub source'])
              json.workspace = { state: 'disabled', provider: 'github' }
            } else if (!wsResult.ok) reportRemoteFailure('Workspace', 'workspace', wsResult.error)
            else if (wsResult.value) reportWorkspace(wsResult.value)
          }
          function reportWorkspace(view: RemoteWorkspaceView): void {
            const localTip = branch ? resolveCommit(appDir!, `refs/heads/${branch}`) : null
            facts.unsynced = localTip !== null && view.tipOid !== localTip
            facts.aheadOfBase = view.aheadOfBase?.count ?? 0
            const behind = view.behindTrunk?.count ?? 0
            lines.push([
              'Workspace',
              `"${view.workspace.task}" · ${facts.unsynced ? 'has UNSYNCED local commits' : 'synced'} · ` +
                `${facts.aheadOfBase} commit${facts.aheadOfBase === 1 ? '' : 's'} ahead of base · ` +
                (behind === 0 ? 'trunk unchanged since base' : `trunk moved ${behind} since base`),
            ])
            json.workspace = {
              task: view.workspace.task,
              unsynced: facts.unsynced,
              aheadOfBase: facts.aheadOfBase,
              behindTrunk: behind,
            }
          }

          // current-branch sync position (only meaningful off a workspace
          // branch). Labeled "Trunk" ONLY when the branch IS the default
          // branch — calling a feature branch's sync state "Trunk in_sync"
          // misreads as "local trunk matches cloud trunk".
          const refs = refsResult.ok ? refsResult.value : undefined
          const trunkRef = refs?.refs.find((r) => `refs/heads/${branch}` === r.name)
          const defaultBranch =
            refs?.head && refs.head.startsWith('refs/heads/')
              ? refs.head.slice('refs/heads/'.length)
              : null
          // Reported on every checkout, workspace ones included — that is
          // exactly where "what does `workspace land` merge into?" is the
          // question. Absent, rather than null, when the refs read failed or
          // the source is external: unknown is not "there is no default".
          if (!githubSource && refsResult.ok && defaultBranch) json.defaultBranch = defaultBranch
          if (!facts.workspaceId && branch) {
            // With the default branch unknown (GitHub-owned source, refs
            // unfetched, or a repo with no HEAD yet) `isTrunk` is null and
            // the label stays 'Trunk' — asserted true/false only where it is
            // actually derivable, so a machine caller can't read a guess.
            const isTrunk = defaultBranch === null ? null : branch === defaultBranch
            const label = isTrunk === false ? 'Branch sync' : 'Trunk'
            // NAME the trunk when this checkout is not on it; the rows below
            // only describe `branch`, so the human view otherwise never says
            // what the default branch is. Not for GitHub-owned source, where
            // `refs.head` is the DeepSpace repo's head rather than the
            // authority — and where the arm below already prints a Trunk row.
            if (isTrunk === false && defaultBranch && !githubSource) {
              lines.push(['Trunk', `${defaultBranch} (this checkout is on ${branch})`])
            }
            if (githubSource) {
              lines.push([label, `${branch} is owned through normal Git/GitHub`])
              json.trunk = { state: 'external', provider: 'github', branch, isTrunk }
            } else if (!refsResult.ok) reportRemoteFailure(label, 'trunk', refsResult.error)
            else {
              const remoteOid = trunkRef?.oid ?? null
              const localOid = resolveCommit(appDir, `refs/heads/${branch}`)
              const remoteKnownLocally = remoteOid
                ? resolveCommit(appDir, remoteOid) !== null
                : false
              facts.trunkState =
                remoteOid === null && localOid === null
                  ? 'unknown'
                  : remoteOid === localOid
                    ? 'in_sync'
                    : remoteOid &&
                        localOid &&
                        remoteKnownLocally &&
                        isAncestor(appDir, remoteOid, localOid)
                      ? 'local_ahead'
                      : remoteOid &&
                          localOid &&
                          remoteKnownLocally &&
                          isAncestor(appDir, localOid, remoteOid)
                        ? 'local_behind'
                        : remoteOid && localOid && remoteKnownLocally
                          ? 'diverged'
                          : 'differs'
              lines.push([
                label,
                remoteOid === null
                  ? `cloud repo has no ${branch} yet`
                  : facts.trunkState === 'in_sync'
                    ? `${branch} in sync with the cloud repo (${remoteOid.slice(0, 10)})`
                    : `${branch} ${facts.trunkState.replace('_', ' ')} relative to the cloud repo (local ${localOid?.slice(0, 10) ?? 'none'}, cloud ${remoteOid.slice(0, 10)})`,
              ])
              json.trunk = { state: facts.trunkState, localOid, remoteOid, branch, isTrunk }
            }
          }

          // Live state. The release log is append-only history — undeploy never
          // touches it — so what is SERVING comes from the registry entry, the
          // same row `deepspace app list` prints. The release only describes
          // WHICH build that is.
          if (!releaseResult.ok) reportRemoteFailure('Live', 'live', releaseResult.error)
          else if (!appsResult.ok) reportRemoteFailure('Live', 'live', appsResult.error)
          else reportLive(releaseResult.value, appsResult.value.find((a) => a.appId === appId))
          function reportRemoteFailure(label: string, key: string, error: unknown): void {
            const failure = statusRemoteFailure(error)
            lines.push([label, failure.human])
            json[key] = failure.json
          }
          function reportLive(rel: RemoteRelease | null, entry: AppListEntry | undefined): void {
            if (rel === null) {
              lines.push(['Live', 'never deployed'])
              json.live = null
              return
            }
            const byYou = userId !== null && rel.actor === userId
            const release =
              `release #${rel.seq} (${rel.kind} of ${releaseSourceLabel(rel)}, ` +
              `${timeAgo(rel.createdAt)}${byYou ? ', by you' : ''})`
            const details = {
              seq: rel.seq,
              kind: rel.kind,
              commitOid: rel.commitOid,
              createdAt: rel.createdAt,
              byYou,
              source: rel.source,
              sourceRevision: rel.sourceRevision,
              // The human line can say "dirty worktree"; the machine mirror
              // must be able to say the same.
              sourceDirty: rel.sourceDirty ?? null,
            }
            // The listing answered, but not about this app. An admin acting on
            // someone else's app sees exactly this, and it is NOT evidence the
            // app is down — so report the release and say liveness is unknown
            // rather than inventing "unregistered".
            if (!entry) {
              lines.push(['Live', `${release} · serving state not visible from your account`])
              json.live = { ...details, serving: null, url: null }
              return
            }
            const url = liveAppUrl(entry)
            lines.push([
              'Live',
              url ? `${release} · ${url}` : `not serving — ${entry.status}, last ${release}`,
            ])
            json.live = { ...details, serving: url !== null, url }
          }
        }
        spinner?.stop('Cloud state checked.')
      }
    }

    if (args.json) {
      console.log(JSON.stringify(json))
      return
    }
    const width = Math.max(...lines.map(([k]) => k.length))
    // The one exit every row leaves by, so no row can be composed from remote
    // text (a branch name, a workspace task) and printed unescaped — a bidi
    // override in any of them reorders the rest of the line.
    for (const [k, v] of lines) p.log.message(displayLines(`${k.padEnd(width)}  ${v}`))
  },
})
