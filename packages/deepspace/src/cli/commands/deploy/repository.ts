import * as p from '@clack/prompts'
import {
  assertNoOperationInProgress,
  assertSyncableRepo,
  currentBranch,
  isAncestor,
  isWorkTreeClean,
  resolveCommit,
  revListCount,
} from '../../lib/git/repository'
import {
  secretRecoverySentence,
  trackedSecretFiles,
  unmergedIndexRefusal,
} from '../../lib/git/safety'
import { mintIdempotencyKey, repoApi, type RemoteWorkspace } from '../../lib/repo-api'
import {
  classifyPushTransportFailure,
  pushFailureMessage,
  pushToSpace,
  type PushRefResult,
} from '../../lib/vc-push'
import { ensureSpaceRemote, removeSpaceRemote, runGitRemote, spaceRemoteName } from '../../lib/vc-remote'
import { workspaceIdFromBranch } from '../../lib/workspace-id'
import { CliExit, errorCode } from '../../lib/cli-errors'
import { listGitHubRemotes, selectGitHubRemote } from '../../lib/source-control'
import { getAppSource, type AppSource, type AppSourceState } from '../../lib/source-api'
import type { DeployOutput } from './output'

export interface DeployRepositoryState {
  commitOid: string | null
  recoverable: boolean
  deployKey: string
  source: AppSource | null
  sourceRevision: number
  /** The branch this release was built from; null on a detached HEAD or a
   *  non-repository app dir. */
  branch: string | null
  /** Whether the tree carried uncommitted changes; null when there is no
   *  repository to ask. */
  dirty: boolean | null
  /**
   * INFERRED-GitHub evidence only: the repository an unclaimed checkout's
   * remote points at, recorded per release. Deliberately NOT carried as
   * `source` — a 0.25.0 worker trusts a request's claimed source and would
   * skip its stale-base guard on it; this separate field is simply ignored
   * by older workers. Null for claimed apps and non-GitHub checkouts.
   */
  observedRepository: string | null
}

/**
 * Branch and cleanliness of the tree being deployed, read once for every path
 * through `syncDeployRepository`. Descriptive, never a gate: the GitHub-source
 * and `--no-push` paths deploy trees that need not be a syncable repo at all
 * (a depth-1 CI clone, no git). When git cannot answer, the answer is
 * null/null — "unknown", reported as such — and the paths that DO require a
 * syncable repo assert it themselves, with their own refusals.
 */
function describeWorktree(appDir: string): { branch: string | null; dirty: boolean | null } {
  try {
    return { branch: currentBranch(appDir), dirty: !isWorkTreeClean(appDir) }
  } catch {
    return { branch: null, dirty: null }
  }
}

/**
 * Whether this deploy's git truth lives OUTSIDE the platform: a claimed
 * GitHub app, or an unclaimed app whose checkout has a GitHub remote. The
 * inference that replaced the `source_unclaimed` question — nothing is
 * registered up front; a checkout that points at GitHub deploys as GitHub
 * until the day a `deepspace push` claims DeepSpace source by using it.
 */
export function externalGitSource(appDir: string, source: AppSource | null): boolean {
  if (source?.provider === 'github') return true
  if (source !== null) return false
  try {
    return listGitHubRemotes(appDir).length > 0
  } catch {
    // No git on PATH, or no repository: nothing external to defer to.
    return false
  }
}

/** The repository label an unclaimed deploy records as evidence: the
 *  unambiguous remote when there is one, else the first GitHub remote — an
 *  arbitrary-but-deterministic pick still names A repository the checkout
 *  points at, where null would drop the evidence (and the server's stale
 *  guard with it). */
function observedGitHubRepository(appDir: string): string | null {
  try {
    return (
      selectGitHubRemote(appDir)?.repository ?? listGitHubRemotes(appDir)[0]?.repository ?? null
    )
  } catch {
    return null
  }
}

/**
 * Read-only local checks that should fail before an expensive build. The
 * actual sync repeats these checks immediately before its remote mutation so
 * a working tree changed during the build still fails safely.
 */
export function preflightDeployRepository(options: {
  appDir: string
  push: boolean
  source: AppSource | null
}): { code: string; error: string } | null {
  const { appDir, push, source } = options
  if (!push || externalGitSource(appDir, source)) return null

  try {
    assertSyncableRepo(appDir)
    // Before the dirty check: a half-finished merge IS a dirty tree, but
    // "commit them" is not its remedy — the same refusal push and pull give.
    assertNoOperationInProgress(appDir)
    const branch = currentBranch(appDir)
    // The checkout is passed so an UNRESOLVED merge is reported as itself
    // rather than as "uncommitted changes" (whose advice would commit the
    // markers and ship them).
    if (!isWorkTreeClean(appDir)) return dirtyWorktreeRefusal(branch, appDir)
    if (!branch) return detachedHeadRefusal()
    return null
  } catch (error: unknown) {
    return deployRepositoryFailure(error, appDir)
  }
}

export async function syncDeployRepository(options: {
  deployUrl: string
  appDir: string
  appId: string
  token: string
  push: boolean
  ignoreStale: boolean
  output: DeployOutput
  sourceState: AppSourceState
}): Promise<DeployRepositoryState> {
  const { deployUrl, appDir, appId, token, push, ignoreStale, output, sourceState } = options
  let commitOid: string | null = null
  let recoverable = false
  const deployKey = mintIdempotencyKey()
  let source = sourceState.source
  let sourceRevision = sourceState.revision
  const worktree = describeWorktree(appDir)

  // No cloud-repo probe here: an unclaimed app with DeepSpace history cannot
  // exist. Pushing and claiming happen at the same receive path (any writer,
  // since this release; the owner since v0.15.0, when the repo store and the
  // source model shipped together), so "has history" implies "claimed" by
  // construction, and the local inference below is the whole answer.
  const external = externalGitSource(appDir, source)

  // GitHub owns source — claimed, or inferred from the checkout's remote on
  // an unclaimed app with no DeepSpace history — and deployment remains the
  // traditional manual flow: ship the local working tree without inspecting
  // or mutating Git. Only DeepSpace source has commit-first synchronization
  // and workspace lineage.
  if (external) {
    // A CLAIMED GitHub app's `space` remote is definitionally dead (the
    // server refuses it with a bodiless 422 git cannot render). The old
    // `app source github` claim removed it; with the setter gone, deploy —
    // the verb GitHub apps actually run — self-heals it instead. Scoped to
    // claimed apps only: on an UNCLAIMED app the remote is functional (a
    // push through it claims DeepSpace source), so it is left alone.
    if (sourceState.source?.provider === 'github') {
      try {
        if (removeSpaceRemote(appDir)) {
          p.log.info(`Removed the stale \`space\` git remote — GitHub owns this app's source.`)
        }
      } catch {
        // Local git-config cleanup must never fail a deploy.
      }
    }
    // The observed repository is the LATCH input: an unclaimed app's first
    // release fixes its source permanently, and the server's deploy commit
    // route latches `github` from exactly this field (none ⇒ deepspace).
    // Carried as its own field, never as claimed `source` (see
    // DeployRepositoryState — a 0.25.0 worker would trust it and skip its
    // stale guard).
    const observedRepository = source === null ? observedGitHubRepository(appDir) : null
    if (observedRepository) {
      // stderr: the permanent-latch fact must reach --json callers too.
      process.stderr.write(
        `This app's source is unclaimed — this deploy's release claims GitHub source ` +
          `(${observedRepository}) for it, permanently. DeepSpace source verbs ` +
          `(push/pull/clone/workspace) will refuse from now on; if this checkout's GitHub ` +
          `remote is accidental, deploy as a fresh app instead (\`deepspace app init --new-id\`).\n`,
      )
    }
    // This release records no commit, so the branch and the dirty flag are the
    // only trace of what it shipped. Say them — the deploy is NOT refused
    // (shipping the working tree is what GitHub source means), but an
    // uncommitted tree going live silently was untraceable from every surface.
    const where = `GitHub source: shipping the working tree of ${worktree.branch ?? '(detached HEAD)'}`
    if (worktree.dirty) {
      p.log.warn(
        `${where} WITH uncommitted changes. This release records no commit, so nothing can ` +
          'reconstruct afterwards what went live — commit and redeploy if it should be traceable.',
      )
    } else {
      p.log.info(`${where} (clean). GitHub-source releases record no commit lineage.`)
    }
    return { commitOid, recoverable, deployKey, source, sourceRevision, observedRepository, ...worktree }
  }

  if (!push) {
    try {
      assertSyncableRepo(appDir)
      commitOid = resolveCommit(appDir, 'HEAD')
    } catch {
      // A non-repository app can still deploy; it simply has no source lineage.
    }
    // The JSON envelope and the release row both carry the dirty flag; the
    // human running the deploy must hear it too, not learn it from
    // `releases` later — the recorded commit is NOT what shipped.
    if (worktree.dirty) {
      p.log.warn(
        `--no-push: shipping the working tree WITH uncommitted changes — the recorded commit ${commitOid ? commitOid.slice(0, 10) : ''} is not exactly what went live.`,
      )
    }
    return { commitOid, recoverable, deployKey, source, sourceRevision, observedRepository: null, ...worktree }
  }

  try {
    const preflight = preflightDeployRepository({ appDir, push, source })
    if (preflight) output.die(preflight.error, preflight.code)
    const sourceRemote = spaceRemoteName()
    ensureSpaceRemote(appDir, appId, sourceRemote)
    const branch = currentBranch(appDir)
    const workspaceBranchId = workspaceIdFromBranch(branch)

    if (!branch) {
      const refusal = detachedHeadRefusal()
      output.die(refusal.error, refusal.code)
      throw new Error(refusal.error)
    }

    const tip = resolveCommit(appDir, `refs/heads/${branch}`)
    if (!tip) {
      return { commitOid, recoverable, deployKey, source, sourceRevision, observedRepository: null, ...worktree }
    }

    const secretFiles = workspaceBranchId ? [] : trackedSecretFiles(appDir, tip)
    if (workspaceBranchId) {
      const { view } = await repoApi(deployUrl, token, appId).getWorkspace(workspaceBranchId)
      const lineage = workspaceDeployLineage(view.workspace.status, view.tipOid, tip)
      if (lineage === 'inactive') {
        output.die(
          `Workspace ${workspaceBranchId} is ${view.workspace.status}; deploy from trunk or create a new workspace.`,
          'workspace_not_active',
        )
      }
      if (lineage === 'unsynced') {
        output.die(
          `Workspace ${workspaceBranchId} has unsynced commits. Publish this exact HEAD before deploying so the release keeps recoverable source lineage.`,
          'workspace_unsynced',
          {
            action: { cwd: appDir, argv: ['deepspace', 'workspace', 'sync'] },
            actionRequired: true,
          },
        )
      }
      recoverable = true
      p.log.info(`Workspace ${workspaceBranchId} is synced at ${tip.slice(0, 10)}.`)
    } else if (secretFiles.length > 0) {
      p.log.warn(
        `Skipping cloud-repo push — the branch tracks secret file(s): ${secretFiles.join(', ')}. ` +
          secretRecoverySentence(secretFiles, '`deepspace push`') +
          ` Without the push this deploy carries no source lineage: if the live ` +
          `release has one, the server refuses it as stale (--ignore-stale replaces it anyway), and ` +
          `this release's source isn't recoverable until the push works.`,
      )
    } else {
      // The push below LATCHES DeepSpace source on an unclaimed app —
      // permanent (the server's pack POST is the latch; a legacy app whose
      // ledger records GitHub latches github there and the push is refused
      // instead). Announced only after the pack actually committed, and only
      // on the path that pushed (the secret-files skip and the workspace
      // path above never send the pack, so the sentence would be false
      // there). stderr: the fact must reach --json callers too.
      const wasUnclaimed = sourceState.source === null
      const pushResult = await pushWithTransientRetry(() =>
        pushToSpace(appDir, token, `refs/heads/${branch}:refs/heads/${branch}`, {
          remote: sourceRemote,
        }),
      )
      if (pushResult.status === 'committed' || pushResult.status === 'up_to_date') {
        recoverable = true
        if (pushResult.status === 'committed') {
          p.log.info(`Pushed ${branch} → ${tip.slice(0, 10)}.`)
          if (wasUnclaimed) {
            process.stderr.write(
              "This app's source is now DeepSpace — claimed by this deploy's push, permanently.\n",
            )
          }
        }
      } else if (pushResult.status === 'rejected') {
        // The SAME rendering `deepspace push` gives, so an oversized object
        // carries its correction here too instead of a bare "resolve it".
        // Divergent copies of this sentence are how deploy ended up telling
        // users less than push did about the identical rejection.
        output.die(
          `${pushFailureMessage('Cloud repo push', pushResult, appDir)} ` +
            `Publish the commit before deploying.`,
          'vc_push_rejected',
        )
      } else {
        const remoteState = classifyRemoteState(appDir, token, branch, tip, sourceRemote)
        if (remoteState.strictlyBehind && !ignoreStale) {
          let behind = 'several'
          try {
            behind = String(revListCount(appDir, tip, remoteState.remoteTip as string))
          } catch {
            // The count is decoration; the refusal remains valid without it.
          }
          const message =
            `Your ${branch} is ${behind} commit(s) behind the cloud repo — deploying would take ` +
            `already-landed work off the live app. Run \`deepspace pull\`, then redeploy ` +
            `(or pass --ignore-stale to ship this older tree anyway).`
          output.die(message, 'behind_trunk', {
            action: {
              cwd: appDir,
              argv: ['deepspace', 'pull'],
            },
            actionRequired: true,
          })
        }
        if (remoteState.strictlyBehind) {
          recoverable = true
          p.log.warn(
            `Deploying a tree behind the cloud repo (--ignore-stale) — the live app reverts to ` +
              `${tip.slice(0, 10)} until the next deploy from an up-to-date checkout.`,
          )
        } else {
          output.die(
            `Cloud repo's ${branch} diverged (${pushResult.status}). Integrate the cloud tip, or explicitly publish an intentional history rewrite, before deploying.`,
            'vc_diverged',
            {
              action: { cwd: appDir, argv: ['deepspace', 'pull'] },
              actionRequired: true,
            },
          )
        }
      }
    }
    commitOid = tip
    if (!source) {
      const claimed = await getAppSource(deployUrl, token, appId)
      source = claimed.source
      sourceRevision = claimed.revision
    }
  } catch (error: unknown) {
    // The die() refusals above unwind through here as an already-rendered
    // CliExit — let it pass rather than re-wrapping it as vc_sync_failed.
    if (error instanceof CliExit) throw error
    const failure = deployRepositoryFailure(error, appDir)
    output.die(failure.error, failure.code)
  }

  return { commitOid, recoverable, deployKey, source, sourceRevision, observedRepository: null, ...worktree }
}

function classifyRemoteState(
  appDir: string,
  token: string,
  branch: string,
  localTip: string,
  remote: string,
): { remoteTip: string | null; strictlyBehind: boolean } {
  let remoteTip: string | null = null
  const remoteRef = `refs/remotes/${remote}/${branch}`
  try {
    runGitRemote(appDir, token, ['fetch', '--quiet', remote, `+refs/heads/${branch}:${remoteRef}`])
    remoteTip = resolveCommit(appDir, remoteRef)
    return {
      remoteTip,
      strictlyBehind:
        remoteTip !== null && remoteTip !== localTip && isAncestor(appDir, localTip, remoteTip),
    }
  } catch {
    return { remoteTip, strictlyBehind: false }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function deployRepositoryFailure(
  error: unknown,
  /** The app checkout, so an oversized push can name the offending files. */
  cwd?: string,
): { code: string; error: string } {
  const transportFailure = classifyPushTransportFailure(error, cwd)
  if (transportFailure) return transportFailure

  const code = errorCode(error)
  const message = errorMessage(error)
  if (code && code !== 'git_error') return { code, error: message }
  return {
    code: code ?? 'vc_sync_failed',
    error: `Version-control sync failed: ${message}`,
  }
}

/**
 * Total wall-clock this retry loop may consume. Each attempt re-uploads the
 * whole pack, so a bounded ATTEMPT count is not a bounded WAIT — three retries
 * of a slow 32 MiB push can run for many minutes with no output. The deadline
 * is what actually guarantees deploy fails fast; the per-attempt ceiling in
 * `runGit` guarantees a single attempt cannot hang inside it.
 */
const PUSH_RETRY_BUDGET_MS = 120_000

export async function pushWithTransientRetry(push: () => PushRefResult): Promise<PushRefResult> {
  const backoffMs = [500, 1500, 3500]
  const deadline = Date.now() + PUSH_RETRY_BUDGET_MS
  for (let attempt = 0; ; attempt++) {
    try {
      return push()
    } catch (error) {
      const message = errorMessage(error)
      const transient = /(?:HTTP |error: )(?:429|503)\b/i.test(message)
      if (transient && attempt < backoffMs.length && Date.now() + backoffMs[attempt] < deadline) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]))
        continue
      }
      throw error
    }
  }
}

export function shouldSendLineage(commitOid: string | null, recoverable: boolean): boolean {
  return commitOid !== null && recoverable
}

export function workspaceDeployLineage(
  status: RemoteWorkspace['status'],
  publishedTip: string | null,
  localTip: string,
): 'recoverable' | 'inactive' | 'unsynced' {
  if (status !== 'active') return 'inactive'
  return publishedTip === localTip ? 'recoverable' : 'unsynced'
}

export function dirtyWorktreeRefusal(
  branch: string | null,
  /** The checkout, when the caller has one. Given it, an UNRESOLVED conflict
   *  is reported as itself instead of as "uncommitted changes" — this
   *  refusal's advice ("WIP commits are fine") would otherwise commit the
   *  `<<<<<<<` markers AND ship them, since deploy publishes what it records. */
  cwd?: string,
): {
  code: string
  error: string
} {
  const conflicted = cwd
    ? unmergedIndexRefusal(cwd, { ours: 'A merge', resume: 'deepspace deploy' })
    : null
  if (conflicted) {
    return {
      code: conflicted.code,
      error: `${conflicted.message} A deploy records the commit it ships, so committing an unresolved merge would ship the markers.`,
    }
  }
  const workspaceId = workspaceIdFromBranch(branch)
  return {
    code: 'dirty_worktree',
    error:
      'The worktree has uncommitted changes, and a deploy records the commit it ships. ' +
      (workspaceId
        ? `Commit them to this workspace branch (${branch}) — WIP commits are fine — then redeploy. `
        : 'Commit them (to a workspace branch if this is work in progress: `deepspace workspace new -t "…"`), then redeploy. ') +
      'Or pass --no-push to deploy without version-control sync — the release then records no source lineage.',
  }
}

export function detachedHeadRefusal(): { code: 'detached_head'; error: string } {
  return {
    code: 'detached_head',
    error:
      'HEAD is detached, so DeepSpace cannot publish this commit to a recoverable branch. ' +
      'Create or switch to a branch before deploying, or pass `--no-push` to explicitly deploy without source lineage.',
  }
}
