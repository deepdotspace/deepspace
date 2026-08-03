import * as p from '@clack/prompts'
import { findAppDir } from '../../lib/app-context'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import { isWorkTreeClean } from '../../lib/git/repository'
import type { CliAction } from '../../lib/output'
import { humanCommand } from '../../lib/cli-format'
import { createSpinner } from '../../lib/spinner'
import {
  cleanupAction,
  cleanupRefusalMessage,
  cleanupJson,
  cleanupWorkspaceLocal,
  inOwnLinkedWorktree,
  isManagedWorkspaceWorktree,
  reportCleanupHuman,
} from './local'
import {
  APP_ARG,
  assertExplicitWorkspaceId,
  inferWorkspaceId,
  resolveApiOnly,
  resolveTarget,
} from './runtime'

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

    const { appDir, api } = await resolveTarget(appArg)
    const id = inferWorkspaceId(appDir, explicitId)
    const ownLinkedWorktree = inOwnLinkedWorktree(appDir, id)
    const cleanupOwnsCheckout = !ownLinkedWorktree || isManagedWorkspaceWorktree(appDir, id)
    if (!keepWorktree && cleanupOwnsCheckout && !isWorkTreeClean(appDir)) {
      const dropArgv = ['deepspace', 'workspace', 'drop', ...(explicitId ? [explicitId] : [])]
      const dropNext = humanCommand(dropArgv)
      throw new Refusal(
        `The worktree has uncommitted changes and cleanup would remove it. Commit them to the workspace branch and re-run \`${dropNext}\`, or pass \`--keep-worktree\` to drop while keeping the worktree. Nothing was dropped.`,
        'dirty_worktree',
        { extra: { workspaceId: id } },
      )
    }

    const { view } = await api.dropWorkspace(id)
    spinner?.message(`Cleaning up ${id} locally…`)
    const cleanup = keepWorktree ? null : cleanupWorkspaceLocal(appDir, id, null)
    const inOwnWorktree = !cleanup && ownLinkedWorktree
    const retainedWorktree =
      cleanup?.worktreeRetained ?? (keepWorktree || inOwnWorktree ? appDir : null)
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
