import * as p from '@clack/prompts'
import {
  assertSyncableRepo,
  currentBranch,
  isAncestor,
  isWorkTreeClean,
  resolveCommit,
  revListCount,
} from '../../lib/git/repository'
import { trackedSecretFiles } from '../../lib/git/safety'
import { mintIdempotencyKey, repoApi, type RemoteWorkspace } from '../../lib/repo-api'
import {
  classifyPushTransportFailure,
  pushFailureMessage,
  pushToSpace,
  type PushRefResult,
} from '../../lib/vc-push'
import { ensureSpaceRemote, runGitRemote, spaceRemoteName } from '../../lib/vc-remote'
import { workspaceIdFromBranch } from '../../lib/workspace-id'
import { CliExit, errorCode } from '../../lib/cli-errors'
import { listGitHubRemotes } from '../../lib/source-control'
import { getAppSource, type AppSource, type AppSourceState } from '../../lib/source-api'
import type { DeployOutput } from './output'

export interface DeployRepositoryState {
  commitOid: string | null
  recoverable: boolean
  deployKey: string
  source: AppSource | null
  sourceRevision: number
  baseReleaseId: string | null
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
  if (!push || source?.provider === 'github') return null

  try {
    assertSyncableRepo(appDir)
    if (!source && listGitHubRemotes(appDir).length > 0) {
      return {
        code: 'source_unclaimed',
        error:
          'This app has a GitHub remote but no claimed source. Choose once with `deepspace app source github` (manual GitHub ownership) or `deepspace app source deepspace` (packaged DeepSpace source), then deploy again.',
      }
    }
    const branch = currentBranch(appDir)
    if (!isWorkTreeClean(appDir)) return dirtyWorktreeRefusal(branch)
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
  const baseReleaseId: string | null = null

  // GitHub owns source, but deployment remains the traditional manual flow:
  // ship the local working tree without inspecting or mutating Git. Only
  // DeepSpace source has commit-first synchronization and workspace lineage.
  if (source?.provider === 'github') {
    return { commitOid, recoverable, deployKey, source, sourceRevision, baseReleaseId }
  }

  if (!push) {
    try {
      assertSyncableRepo(appDir)
      commitOid = resolveCommit(appDir, 'HEAD')
    } catch {
      // A non-repository app can still deploy; it simply has no source lineage.
    }
    return { commitOid, recoverable, deployKey, source, sourceRevision, baseReleaseId }
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
      return { commitOid, recoverable, deployKey, source, sourceRevision, baseReleaseId }
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
          `Untrack with \`git rm --cached ${secretFiles[0]}\` (add to .gitignore), re-commit, then ` +
          `\`deepspace push\`. Without the push this deploy carries no source lineage: if the live ` +
          `release has one, the server refuses it as stale (--ignore-stale replaces it anyway), and ` +
          `this release's source isn't recoverable until the push works.`,
      )
    } else {
      const pushResult = await pushWithTransientRetry(() =>
        pushToSpace(appDir, token, `refs/heads/${branch}:refs/heads/${branch}`, {
          remote: sourceRemote,
        }),
      )
      if (pushResult.status === 'committed' || pushResult.status === 'up_to_date') {
        recoverable = true
        if (pushResult.status === 'committed') {
          p.log.info(`Pushed ${branch} → ${tip.slice(0, 10)}.`)
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

  return { commitOid, recoverable, deployKey, source, sourceRevision, baseReleaseId }
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

export function dirtyWorktreeRefusal(branch: string | null): {
  code: 'dirty_worktree'
  error: string
} {
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
