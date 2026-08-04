import * as p from '@clack/prompts'
import { findAppDir } from '../../lib/app-context'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import { isAncestor, isWorkTreeClean } from '../../lib/git/repository'
import type { CliAction } from '../../lib/output'
import { humanCommand } from '../../lib/cli-format'
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
}): Refusal {
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
      ...(args.workspaceDir ? { action: { cwd: args.workspaceDir, argv: syncArgv } as const } : {}),
      extra: { workspaceId: args.id },
    },
  )
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
      const { view } = await api.dropWorkspace(explicitId)
      spinner?.stop()
      if (!args.json) {
        p.log.success(
          `Dropped ${explicitId}. Its ref sticks around briefly for undo, then is reaped.`,
        )
      }
      return { data: { workspaceId: explicitId, status: view.workspace.status } }
    }

    const { appDir, appId, api } = await resolveTarget(appArg)
    const id = inferWorkspaceId(appDir, explicitId)
    const inspection = inspectWorkspaceCleanup(appDir, id)
    let approvedBranchOid: string | undefined

    // External Git/Codex/Claude worktrees are retained by cleanup, so only a
    // branch that default cleanup actually owns needs publication proof.
    if (!keepWorktree && inspection.willDeleteBranch && inspection.branchOid) {
      const { view: before } = await api.getWorkspace(id)
      const publishedOids = [
        before.tipOid,
        before.workspace.landedOid,
        before.workspace.baseOid,
      ].filter((oid): oid is string => oid !== null)
      if (!isWorkspaceTipPublished(appDir, inspection.branchOid, publishedOids)) {
        throw workspaceUnsyncedRefusal({
          appId,
          id,
          branch: inspection.branch,
          workspaceDir: inspection.checkout.dir,
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

    const { view } = await api.dropWorkspace(id)
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
      ...(retainedWorktree ? { worktree: retainedWorktree } : {}),
      ...(cleanup ? { cleanup: cleanupJson(cleanup) } : {}),
    }
    spinner?.stop()
    if (!args.json) {
      p.log.success(`Dropped ${id}. Its ref sticks around briefly for undo, then is reaped.`)
      if (cleanup && !cleanup.error) reportCleanupHuman(cleanup)
      else if (retainedWorktree) p.log.info(`Retained checkout: ${retainedWorktree}`)
    }
    if (cleanup?.error) {
      const action: CliAction = cleanupAction({
        worktreeDir: cleanup.worktreeDir,
        branch: cleanup.branch,
      })
      throw new Refusal(
        cleanupRefusalMessage({
          error: cleanup.error,
          worktreeDir: cleanup.worktreeDir,
          branch: cleanup.branch,
        }),
        'cleanup_incomplete',
        { actionRequired: true, action, extra: data },
      )
    }
    return { data }
  },
})
