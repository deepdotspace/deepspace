import * as p from '@clack/prompts'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import { resolveCommit } from '../../lib/git/repository'
import { statusFiles } from '../../lib/git/safety'
import { ensureSpaceRemote } from '../../lib/vc-remote'
import { createSpinner } from '../../lib/spinner'
import {
  fetchTrunk,
  lineChangedPaths,
  loadWorkspaceLines,
  localTrunkOid,
  overlapsWith,
  printOverlaps,
  trunkOverlapPaths,
} from './analysis'
import {
  APP_ARG,
  assertExplicitWorkspaceId,
  assertSelectedWorkspaceCheckout,
  inferWorkspaceId,
  pushWorkspaceRef,
  resolveTarget,
} from './runtime'

export const syncWorkspaceCommand = defineDeepspaceCommand({
  meta: {
    name: 'sync',
    description: 'Publish this workspace: push its branch + report changed paths',
  },
  args: {
    workspace: {
      type: 'string',
      alias: 'w',
      description: 'Workspace id (default: inferred from the ws/<id> branch)',
      required: false,
    },
    app: APP_ARG,
  },
  async run({ args }) {
    const workspaceArg = typeof args.workspace === 'string' ? args.workspace : undefined
    assertExplicitWorkspaceId(workspaceArg)
    const spinner = args.json ? null : createSpinner()
    spinner?.start('Preparing workspace sync…')
    const { appDir, appId, token, api } = await resolveTarget(
      typeof args.app === 'string' ? args.app : undefined,
    )
    const id = inferWorkspaceId(appDir, workspaceArg)
    assertSelectedWorkspaceCheckout(appDir, id, ['deepspace', 'workspace', 'sync'])
    const headOid = resolveCommit(appDir, 'HEAD')
    if (!headOid) {
      throw new Refusal('The workspace has no commits yet — commit first, then sync.', 'no_commits')
    }

    spinner?.message(`Syncing ${id}…`)
    const [{ view: before }, refs] = await Promise.all([
      api.getWorkspace(id),
      api.getRefs().catch(() => null),
    ])
    if (before.workspace.status !== 'active') {
      spinner?.stop('Workspace finished.')
      throw new Refusal(
        `Workspace ${id} is ${before.workspace.status} — create a new workspace to continue this line of work.`,
        'workspace_not_active',
        { extra: { status: before.workspace.status } },
      )
    }
    ensureSpaceRemote(appDir, appId)
    pushWorkspaceRef(appDir, token, before.workspace.ref, headOid)

    // Keep advisory overlap math current without turning a transient fetch into a sync failure.
    try {
      fetchTrunk(appDir, token, refs?.head ?? null)
    } catch {
      // localTrunkOid can use the existing tracking ref.
    }

    const trunkOid = localTrunkOid(appDir, refs)
    const line = lineChangedPaths(appDir, before.workspace.baseOid, headOid, trunkOid)
    const changedPaths = line?.paths
    const trunkOverlap = line ? trunkOverlapPaths(appDir, line.diffBase, trunkOid, line.paths) : []
    const overlaps =
      changedPaths && changedPaths.length > 0
        ? overlapsWith(changedPaths, await loadWorkspaceLines(appDir, token, api, trunkOid), id)
        : []

    const upToDate = headOid === before.tipOid
    const view = upToDate ? before : (await api.syncWorkspace(id, { headOid })).view
    const dirty = statusFiles(appDir)
    spinner?.stop(
      upToDate
        ? `Already synced — ${id} is up to date at ${headOid.slice(0, 10)}.`
        : changedPaths !== undefined
          ? `Synced ${id} → ${headOid.slice(0, 10)} (${changedPaths.length} ${changedPaths.length === 1 ? 'file' : 'files'} vs base).`
          : `Synced ${id} → ${headOid.slice(0, 10)} (base not present locally — no overlap report).`,
    )
    printOverlaps(overlaps, args.json)
    if (!args.json && trunkOverlap.length > 0) {
      p.log.warn(
        `Trunk already changed ${trunkOverlap.length} file(s) you also touch — landed work you haven't merged: ` +
          `${trunkOverlap.slice(0, 5).join(', ')}${trunkOverlap.length > 5 ? ` (+${trunkOverlap.length - 5} more)` : ''}. ` +
          `Merge trunk before landing (\`deepspace workspace status\` shows the full picture).`,
      )
    }
    if (!args.json && dirty.length > 0) {
      p.log.warn(
        `${dirty.length} uncommitted ${dirty.length === 1 ? 'file' : 'files'} NOT synced — commit them to this workspace branch (WIP commits are fine — they land with the merge).`,
      )
    }
    return {
      data: {
        status: upToDate ? 'up_to_date' : 'synced',
        workspaceId: id,
        headOid,
        changedPaths: changedPaths ?? null,
        overlaps,
        trunkOverlap,
        uncommitted: dirty,
        view,
      },
    }
  },
})
