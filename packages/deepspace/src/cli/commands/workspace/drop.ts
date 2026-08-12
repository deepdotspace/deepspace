import * as p from '@clack/prompts'
import { findAppDir } from '../../lib/app-context'
import { errorCode } from '../../lib/cli-errors'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import { isAncestor, isWorkTreeClean, resolveCommit } from '../../lib/git/repository'
import type { CliAction } from '../../lib/output'
import { humanCommand } from '../../lib/cli-format'
import { ensureSpaceRemote, runGitRemote, SPACE_REMOTE } from '../../lib/vc-remote'
import type { RemoteWorkspaceView, RepoApi } from '../../lib/repo-api'
import { createSpinner } from '../../lib/spinner'
import {
  cleanupAction,
  cleanupRefusalMessage,
  cleanupJson,
  cleanupWorkspaceLocal,
  inspectWorkspaceCleanup,
  reportCleanupHuman,
} from './local'
import {
  APP_ARG,
  assertExplicitWorkspaceId,
  inferWorkspaceId,
  resolveApiOnly,
  resolveTarget,
} from './runtime'

export function isWorkspaceTipPublished(
  appDir: string,
  localTip: string,
  publishedOids: readonly string[],
): boolean {
  return publishedOids.some(
    (publishedOid) => publishedOid === localTip || isAncestor(appDir, localTip, publishedOid),
  )
}

export function workspaceUnsyncedRefusal(args: {
  appId: string
  id: string
  branch: string
  workspaceDir: string | null
  status: string
}): Refusal {
  const dropKeepArgv = [
    'deepspace',
    'workspace',
    'drop',
    args.id,
    '--app',
    args.appId,
    '--keep-worktree',
  ]
  if (args.status !== 'active') {
    // A finished workspace can never publish these commits — `sync` refuses
    // it — so prescribing the publish path would be the dead end this verb
    // exists to remove. No action: the choice (retain vs discard) is the
    // caller's.
    return new Refusal(
      `${args.id} is already ${args.status} on the server, and this checkout has committed ` +
        `work that was never published — nothing can publish it now. Keep it with ` +
        `\`${humanCommand(dropKeepArgv)}\` (retains the branch/worktree for manual disposal), ` +
        `or delete the branch yourself. Nothing was dropped.`,
      'workspace_unsynced',
      { extra: { workspaceId: args.id, status: args.status } },
    )
  }
  const syncArgv = ['deepspace', 'workspace', 'sync', '--app', args.appId, '--workspace', args.id]
  const dropArgv = ['deepspace', 'workspace', 'drop', args.id, '--app', args.appId]
  const publish = args.workspaceDir
    ? `Publish them first with \`${humanCommand(syncArgv)}\`, then re-run \`${humanCommand(dropArgv)}\`.`
    : `Recreate a worktree from the branch (\`git worktree add <dir> ${args.branch}\`), ` +
      `publish from there with \`${humanCommand(syncArgv)}\`, then re-run \`${humanCommand(dropArgv)}\`.`
  return new Refusal(
    `${args.id} has committed work that isn't published yet. ${publish} ` +
      `Alternatively, pass \`--keep-worktree\` to drop the cloud workspace while retaining ` +
      `the local branch/worktree for manual disposal. Nothing was dropped.`,
    'workspace_unsynced',
    {
      // Exit 1 with an unblock action, deliberately: drop is destructive and
      // refusing it is a hard stop, not the "your turn" hand-off exit 2 means.
      ...(args.workspaceDir ? { action: { cwd: args.workspaceDir, argv: syncArgv } as const } : {}),
      extra: { workspaceId: args.id, status: args.status },
    },
  )
}

/** Drop the workspace remotely, tolerating "already finished" from the server,
 *  and answer with post-call truth: the view as the server now has it, and
 *  whether THIS call performed the remote drop. Exported for tests. */
export async function dropRemoteTolerant(
  api: Pick<RepoApi, 'dropWorkspace' | 'getWorkspace'>,
  id: string,
  statusBefore: string,
): Promise<{ view: RemoteWorkspaceView; remoteDropped: boolean }> {
  try {
    const view = (await api.dropWorkspace(id)).view
    return { view, remoteDropped: statusBefore === 'active' && view.workspace.status === 'dropped' }
  } catch (err) {
    const code = errorCode(err)
    if (code !== 'workspace_not_active') throw err
    // Guarded re-read: a transient failure here must surface the original
    // refusal, not replace it with a lookup error.
    const current = await api.getWorkspace(id).catch(() => null)
    if (!current || current.view.workspace.status === 'active') throw err
    return { view: current.view, remoteDropped: false }
  }
}

export const dropWorkspaceCommand = defineDeepspaceCommand({
  meta: { name: 'drop', description: 'Abandon a workspace (ref retained briefly, then GC)' },
  args: {
    id: {
      type: 'positional',
      description: 'Workspace id (default: inferred from the ws/<id> branch)',
      required: false,
    },
    'keep-worktree': {
      type: 'boolean',
      description: 'Keep the local worktree and branch after dropping',
      default: false,
    },
    app: APP_ARG,
  },
  async run({ args }) {
    const explicitId = typeof args.id === 'string' ? args.id.trim() : undefined
    assertExplicitWorkspaceId(explicitId)
    const appArg = typeof args.app === 'string' ? args.app : undefined
    const keepWorktree = Boolean(args['keep-worktree'])
    const spinner = args.json ? null : createSpinner()
    spinner?.start(`Preparing to drop ${explicitId ?? 'workspace'}…`)
    if (!findAppDir() && explicitId) {
      const { api } = await resolveApiOnly(appArg)
      const statusBefore = (await api.getWorkspace(explicitId)).view.workspace.status
      const { view, remoteDropped } = await dropRemoteTolerant(api, explicitId, statusBefore)
      spinner?.stop()
      if (!args.json) {
        p.log.success(
          remoteDropped
            ? `Dropped ${explicitId}. Its ref sticks around briefly for undo, then is reaped.`
            : `Workspace ${explicitId} was already ${view.workspace.status} on the server — nothing to drop remotely.`,
        )
      }
      return { data: { workspaceId: explicitId, status: view.workspace.status, remoteDropped } }
    }

    const { appDir, appId, token, api } = await resolveTarget(appArg)
    const id = inferWorkspaceId(appDir, explicitId)
    const inspection = inspectWorkspaceCleanup(appDir, id)
    let approvedBranchOid: string | undefined
    const { view: before } = await api.getWorkspace(id)

    // External Git/Codex/Claude worktrees are retained by cleanup, so only a
    // branch that default cleanup actually owns needs publication proof.
    if (!keepWorktree && inspection.willDeleteBranch && inspection.branchOid) {
      const publishedOids = [
        before.tipOid,
        before.workspace.landedOid,
        before.workspace.baseOid,
      ].filter((oid): oid is string => oid !== null)
      let published = isWorkspaceTipPublished(appDir, inspection.branchOid, publishedOids)
      if (!published && before.workspace.status !== 'active') {
        // Landed/dropped from ANOTHER checkout: the proving history lives on
        // trunk and this clone may never have fetched it (the landed ref is
        // deleted at land, so tipOid is null and landedOid isn't a local
        // object). Prove against a freshly fetched trunk tip instead of
        // refusing into a `workspace sync` that would itself refuse.
        ensureSpaceRemote(appDir, appId)
        const refs = await api.getRefs()
        const trunkRef = refs?.head?.startsWith('refs/heads/') ? refs.head : null
        if (trunkRef) {
          runGitRemote(appDir, token, ['fetch', '--quiet', '--refmap=', SPACE_REMOTE, trunkRef], {
            allowFail: true,
          })
          const trunkTip = resolveCommit(appDir, 'FETCH_HEAD')
          published =
            trunkTip !== null &&
            isWorkspaceTipPublished(appDir, inspection.branchOid, [trunkTip])
        }
      }
      if (!published) {
        throw workspaceUnsyncedRefusal({
          appId,
          id,
          branch: inspection.branch,
          workspaceDir: inspection.checkout.dir,
          status: before.workspace.status,
        })
      }
      approvedBranchOid = inspection.branchOid
    }

    const cleanupDir = inspection.willDeleteBranch ? inspection.checkout.dir : null
    if (!keepWorktree && cleanupDir && !isWorkTreeClean(cleanupDir)) {
      const dropArgv = ['deepspace', 'workspace', 'drop', id, '--app', appId]
      const dropNext = humanCommand(dropArgv)
      throw new Refusal(
        `The workspace checkout has uncommitted changes and cleanup would remove it or switch it off ${inspection.branch}. Commit them and re-run \`${dropNext}\`, or pass \`--keep-worktree\` to drop while retaining the checkout. Nothing was dropped.`,
        'dirty_worktree',
        { extra: { workspaceId: id } },
      )
    }

    // A workspace already landed (from another checkout, say) has nothing to
    // drop remotely — but this stale worktree is still worth cleaning up, and
    // no other verb owns that. The publication proof above already accepted
    // the local tip against the landed history, so cleanup is safe.
    // Re-dropping replays server-side, so `before`'s status decides the
    // report: otherwise a no-op replay claims a fresh drop.
    const { view, remoteDropped } = await dropRemoteTolerant(api, id, before.workspace.status)
    spinner?.message(`Cleaning up ${id} locally…`)
    const cleanup = keepWorktree
      ? null
      : cleanupWorkspaceLocal(appDir, id, null, {
          expectedBranchOid: approvedBranchOid,
          retainLocal: !inspection.willDeleteBranch,
        })
    const retainedWorktree =
      cleanup?.worktreeRetained ?? (keepWorktree ? inspection.checkout.dir : null)
    const data = {
      workspaceId: id,
      status: view.workspace.status,
      remoteDropped,
      ...(retainedWorktree ? { worktree: retainedWorktree } : {}),
      ...(cleanup ? { cleanup: cleanupJson(cleanup) } : {}),
    }
    spinner?.stop()
    if (!args.json) {
      // Never claim work that didn't happen: the remote message states only
      // the remote fact; the cleanup reporter below owns what happened locally.
      p.log.success(
        remoteDropped
          ? `Dropped ${id}. Its ref sticks around briefly for undo, then is reaped.`
          : `Workspace ${id} was already ${view.workspace.status} on the server — nothing to drop remotely.`,
      )
      if (cleanup && !cleanup.error) reportCleanupHuman(cleanup)
      else if (retainedWorktree) p.log.info(`Retained checkout: ${retainedWorktree}`)
    }
    if (cleanup?.error) {
      const action: CliAction = cleanupAction({
        worktreeDir: cleanup.worktreeDir,
        leftoverDir: cleanup.leftoverDir,
        branch: cleanup.branch,
      })
      throw new Refusal(
        cleanupRefusalMessage({
          error: cleanup.error,
          worktreeDir: cleanup.worktreeDir,
          leftoverDir: cleanup.leftoverDir,
          branch: cleanup.branch,
        }),
        'cleanup_incomplete',
        { actionRequired: true, action, extra: data },
      )
    }
    return { data }
  },
})
