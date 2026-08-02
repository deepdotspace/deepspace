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
import { classifyPushTransportFailure, pushToSpace, type PushRefResult } from '../../lib/vc-push'
import { ensureSpaceRemote, runGitRemote, SPACE_REMOTE } from '../../lib/vc-remote'
import { workspaceIdFromBranch } from '../../lib/workspace-id'
import { errorCode } from '../../lib/cli-errors'
import type { DeployOutput } from './output'

export interface DeployRepositoryState {
  commitOid: string | null
  recoverable: boolean
  deployKey: string
}

export async function syncDeployRepository(options: {
  deployUrl: string
  appDir: string
  appId: string
  token: string
  push: boolean
  ignoreStale: boolean
  output: DeployOutput
}): Promise<DeployRepositoryState> {
  const { deployUrl, appDir, appId, token, push, ignoreStale, output } = options
  let commitOid: string | null = null
  let recoverable = false
  const deployKey = mintIdempotencyKey()

  if (!push) {
    try {
      assertSyncableRepo(appDir)
      commitOid = resolveCommit(appDir, 'HEAD')
    } catch {
      // A non-repository app can still deploy; it simply has no source lineage.
    }
    return { commitOid, recoverable, deployKey }
  }

  try {
    assertSyncableRepo(appDir)
    ensureSpaceRemote(appDir, appId)
    const branch = currentBranch(appDir)
    const workspaceBranchId = workspaceIdFromBranch(branch)

    if (!isWorkTreeClean(appDir)) {
      const refusal = dirtyWorktreeRefusal(branch)
      output.die(refusal.error, refusal.code)
    }

    if (!branch) {
      commitOid = resolveCommit(appDir, 'HEAD')
      return { commitOid, recoverable, deployKey }
    }

    const tip = resolveCommit(appDir, `refs/heads/${branch}`)
    if (!tip) return { commitOid, recoverable, deployKey }

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
          `\`deepspace push\`. Deploy continues; this release's source isn't recoverable until then.`,
      )
    } else {
      const pushResult = await pushWithTransientRetry(() =>
        pushToSpace(appDir, token, `refs/heads/${branch}:refs/heads/${branch}`),
      )
      if (pushResult.status === 'committed' || pushResult.status === 'up_to_date') {
        recoverable = true
        if (pushResult.status === 'committed') {
          p.log.info(`Pushed ${branch} → ${tip.slice(0, 10)}.`)
        }
      } else if (pushResult.status === 'rejected') {
        output.die(
          `Cloud repo rejected ${branch}${pushResult.reason ? `: ${pushResult.reason}` : ''}. Resolve the rejection and publish the commit before deploying.`,
          'vc_push_rejected',
        )
      } else {
        const remoteState = classifyRemoteState(appDir, token, branch, tip)
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
  } catch (error: unknown) {
    const failure = deployRepositoryFailure(error)
    output.die(failure.error, failure.code)
  }

  return { commitOid, recoverable, deployKey }
}

function classifyRemoteState(
  appDir: string,
  token: string,
  branch: string,
  localTip: string,
): { remoteTip: string | null; strictlyBehind: boolean } {
  let remoteTip: string | null = null
  try {
    runGitRemote(appDir, token, [
      'fetch',
      '--quiet',
      SPACE_REMOTE,
      `+refs/heads/${branch}:refs/remotes/space/${branch}`,
    ])
    remoteTip = resolveCommit(appDir, `refs/remotes/space/${branch}`)
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

export function deployRepositoryFailure(error: unknown): { code: string; error: string } {
  const transportFailure = classifyPushTransportFailure(error)
  if (transportFailure) return transportFailure

  const code = errorCode(error)
  const message = errorMessage(error)
  if (code && code !== 'git_error') return { code, error: message }
  return {
    code: code ?? 'vc_sync_failed',
    error: `Version-control sync failed: ${message}`,
  }
}

export async function pushWithTransientRetry(push: () => PushRefResult): Promise<PushRefResult> {
  const backoffMs = [500, 1500, 3500]
  for (let attempt = 0; ; attempt++) {
    try {
      return push()
    } catch (error) {
      const message = errorMessage(error)
      if (/(?:HTTP |error: )(?:429|503)\b/i.test(message) && attempt < backoffMs.length) {
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
