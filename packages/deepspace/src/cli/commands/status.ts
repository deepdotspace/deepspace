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
import * as p from '@clack/prompts'
import { existsSync, readFileSync } from 'node:fs'
import { SESSION_PATH, TOKEN_PATH, ensureToken } from '../auth'
import { DEEPSPACE_ENV, effectivePlatformUrls } from '../env'
import { decodeJwtPayload } from '../jwt'
import { findAppDir, detectAppName } from '../lib/app-context'
import { readAppId } from '../lib/app-identity'
import { currentBranch, isAncestor, resolveCommit } from '../lib/git/repository'
import { statusFiles } from '../lib/git/safety'
import { workspaceIdFromBranch } from '../lib/workspace-id'
import { deployBaseUrl } from '../lib/vc-remote'
import { repoApi, type RemoteRelease, type RemoteWorkspaceView } from '../lib/repo-api'
import { errorCode } from '../lib/cli-errors'
import { installState } from '../lib/install-status'
import { installCommand } from '../lib/package-manager'
import { createSpinner } from '../lib/spinner'
import { InputError } from '../lib/cli-errors'
import { readWranglerConfig, resolveAppNameForEnv } from '../lib/wrangler-env'
import { getAppSource } from '../lib/source-api'
import { parseWranglerEnvArg } from '../lib/app-target'

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
): { appName: string; appId: string | null } {
  if (!wranglerEnv) {
    return { appName: detectAppName(appDir) ?? '(unnamed)', appId: readAppId(appDir) }
  }
  const resolved = resolveAppNameForEnv(readWranglerConfig(appDir), wranglerEnv)
  if (!resolved.ok) throw new InputError(resolved.reason, 'invalid_env')
  return { appName: resolved.name, appId: readAppId(appDir, wranglerEnv) }
}

export default defineCommand({
  meta: {
    name: 'status',
    description: 'One screenful of current state: session, app, workspace, and live release',
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

    // ── environment (print ONLY when not plain prod — half of all staging
    // confusion is not being able to see which plane a command talks to) ──
    const urlOverrides = [
      'DEEPSPACE_DEPLOY_URL',
      'DEEPSPACE_AUTH_URL',
      'DEEPSPACE_API_URL',
      'DEEPSPACE_PLATFORM_URL',
    ].filter((k) => process.env[k])
    if (DEEPSPACE_ENV !== 'production' || urlOverrides.length > 0) {
      const urls = effectivePlatformUrls()
      const detail = [
        DEEPSPACE_ENV !== 'production' ? DEEPSPACE_ENV : null,
        ...urlOverrides.map((k) => `${k} set`),
      ]
        .filter(Boolean)
        .join(' · ')
      lines.push(['Env', detail])
      lines.push([
        'Services',
        `auth ${urls.auth} · api ${urls.api} · platform ${urls.platform} · deploy ${urls.deploy}`,
      ])
      json.env = DEEPSPACE_ENV
      json.services = urls
      if (urlOverrides.length > 0) json.urlOverrides = urlOverrides
    }

    // ── session (local only — never blocks on the network) ──────────────
    facts.loggedIn = existsSync(SESSION_PATH)
    let userId: string | null = null
    if (!facts.loggedIn) {
      lines.push(['Session', 'not logged in'])
      json.loggedIn = false
    } else {
      let who = 'logged in'
      try {
        const payload = decodeJwtPayload<{ email?: string; sub?: string }>(
          readFileSync(TOKEN_PATH, 'utf-8').trim(),
        )
        if (payload.email) who = payload.email
        userId = payload.sub ?? null
      } catch {
        // token file absent/stale — the session still mints on next use
      }
      lines.push(['Session', `${who} · renews on use (re-login only after 30 idle days)`])
      json.loggedIn = true
      json.user = who
    }

    // ── app (local) ──────────────────────────────────────────────────────
    const appDir = findAppDir()
    if (!appDir) {
      lines.push(['App', 'not inside a DeepSpace app directory'])
      json.inApp = false
    } else {
      const { appName, appId } = resolveStatusApp(appDir, wranglerEnv)
      lines.push([
        'App',
        `${appName}${wranglerEnv ? ` [env.${wranglerEnv}]` : ''}${appId ? ` (${appId})` : ' — no DEEPSPACE_APP_ID; run `deepspace app init`'}`,
      ])
      json.inApp = true
      json.appName = appName
      json.appId = appId
      if (wranglerEnv) json.wranglerEnv = wranglerEnv

      const deps = installState(appDir)
      const depsInstallCommand = installCommand(appDir)
      lines.push([
        'Deps',
        deps === 'ready'
          ? 'installed'
          : deps === 'installing'
            ? 'dependency installation is still running'
            : `${deps} — run ${depsInstallCommand}`,
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
            lines.push(['Source', 'unclaimed · next normal deploy defaults to DeepSpace'])
            json.source = null
          }
          const [refsResult, wsResult, releaseResult] = await Promise.all([
            githubSource
              ? Promise.resolve({ ok: true, value: null } as const)
              : observeRemote(api.getRefs()),
            facts.workspaceId && !githubSource
              ? observeRemote(api.getWorkspace(facts.workspaceId).then((r) => r.view))
              : Promise.resolve({ ok: true, value: null } as const),
            observeRemote(api.latestRelease().then((r) => r.release)),
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

          // trunk position (only meaningful off a workspace branch)
          const refs = refsResult.ok ? refsResult.value : undefined
          const trunkRef = refs?.refs.find((r) => `refs/heads/${branch}` === r.name)
          if (!facts.workspaceId && branch) {
            if (githubSource) {
              lines.push(['Trunk', `${branch} is owned through normal Git/GitHub`])
              json.trunk = { state: 'external', provider: 'github', branch }
            } else if (!refsResult.ok) reportRemoteFailure('Trunk', 'trunk', refsResult.error)
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
                'Trunk',
                remoteOid === null
                  ? `cloud repo has no ${branch} yet`
                  : facts.trunkState === 'in_sync'
                    ? `${branch} in sync with the cloud repo (${remoteOid.slice(0, 10)})`
                    : `${branch} ${facts.trunkState.replace('_', ' ')} relative to the cloud repo (local ${localOid?.slice(0, 10) ?? 'none'}, cloud ${remoteOid.slice(0, 10)})`,
              ])
              json.trunk = { state: facts.trunkState, localOid, remoteOid }
            }
          }

          // live release
          if (!releaseResult.ok) reportRemoteFailure('Live', 'live', releaseResult.error)
          else if (releaseResult.value === null) {
            lines.push(['Live', 'never deployed'])
            json.live = null
          } else {
            reportRelease(releaseResult.value)
          }
          function reportRemoteFailure(label: string, key: string, error: unknown): void {
            const failure = statusRemoteFailure(error)
            lines.push([label, failure.human])
            json[key] = failure.json
          }
          function reportRelease(rel: RemoteRelease): void {
            const byYou = userId !== null && rel.actor === userId
            lines.push([
              'Live',
              `release #${rel.seq} (${rel.kind} of ${rel.commitOid?.slice(0, 10) ?? 'unknown source'}, ${timeAgo(rel.createdAt)}${byYou ? ', by you' : ''})` +
                (rel.url ? ` · ${rel.url}` : ''),
            ])
            json.live = {
              seq: rel.seq,
              kind: rel.kind,
              commitOid: rel.commitOid,
              createdAt: rel.createdAt,
              url: rel.url,
              byYou,
              source: rel.source,
              sourceRevision: rel.sourceRevision,
            }
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
    for (const [k, v] of lines) p.log.message(`${k.padEnd(width)}  ${v}`)
  },
})
