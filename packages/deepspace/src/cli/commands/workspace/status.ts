import * as p from '@clack/prompts'
import { defineDeepspaceCommand } from '../../lib/command'
import { listWorktrees, resolveCommit, revListCount } from '../../lib/git/repository'
import { statusFiles } from '../../lib/git/safety'
import { ensureSpaceRemote, SPACE_REMOTE } from '../../lib/vc-remote'
import { createSpinner } from '../../lib/spinner'
import { resolveWorkspaceWorktree } from '../../lib/workspace-id'
import {
  fetchTrunk,
  lineChangedPaths,
  loadWorkspaceLines,
  overlapsWith,
  peerWorkspaceRef,
  printOverlaps,
  trunkOverlapPaths,
  workspaceSyncRelation,
} from './analysis'
import { APP_ARG, assertExplicitWorkspaceId, inferWorkspaceId, resolveTarget } from './runtime'

export const workspaceStatusCommand = defineDeepspaceCommand({
  meta: { name: 'status', description: 'This workspace: base staleness, overlaps, sync state' },
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
    spinner?.start('Preparing workspace status…')
    const { appDir, appId, token, api } = await resolveTarget(
      typeof args.app === 'string' ? args.app : undefined,
    )
    const id = inferWorkspaceId(appDir, workspaceArg)
    spinner?.message(`Checking ${id}…`)
    ensureSpaceRemote(appDir, appId)
    const [{ view }, refs] = await Promise.all([api.getWorkspace(id), api.getRefs()])
    const workspace = view.workspace

    // Read checkout-only state from this workspace's actual worktree. Object-level
    // graph queries can safely use appDir even when status is invoked elsewhere.
    const workspaceDir = resolveWorkspaceWorktree(listWorktrees(appDir), id)
    const attached = workspaceDir !== null
    const headOid = workspaceDir ? resolveCommit(workspaceDir, 'HEAD') : null
    const trunk = fetchTrunk(appDir, token, refs?.head ?? null)
    const trunkOid = trunk?.oid ?? null
    const baseLocal = resolveCommit(appDir, workspace.baseOid) !== null
    const behindExact =
      trunk && baseLocal ? revListCount(appDir, workspace.baseOid, trunk.oid) : null
    const aheadExact =
      headOid && baseLocal ? revListCount(appDir, workspace.baseOid, headOid) : null
    const unsynced = headOid !== null && view.tipOid !== headOid
    const dirty = workspaceDir ? statusFiles(workspaceDir) : []

    // One relation drives the human line AND `--json syncRelation` — deriving
    // them separately is how the two surfaces drift apart. A finished
    // workspace answers `unknown`: its checkout is a leftover, not a line to
    // reconcile.
    const relation = !unsynced
      ? ('in_sync' as const)
      : workspace.status !== 'active' || !workspaceDir
        ? ('unknown' as const)
        : workspaceSyncRelation(workspaceDir, headOid, view.tipOid)

    const lines = await loadWorkspaceLines(appDir, token, api, trunkOid)
    const myTip = headOid ?? resolveCommit(appDir, peerWorkspaceRef(id)) ?? view.tipOid
    const line = myTip ? lineChangedPaths(appDir, workspace.baseOid, myTip, trunkOid) : null
    const trunkOverlap = line ? trunkOverlapPaths(appDir, line.diffBase, trunkOid, line.paths) : []
    const overlaps = overlapsWith(line?.paths ?? [], lines, id)

    spinner?.stop(`Workspace ${id} (${workspace.status}).`)
    const data = {
      workspaceId: id,
      task: workspace.task,
      status: workspace.status,
      baseOid: workspace.baseOid,
      syncedTip: view.tipOid,
      landedOid: workspace.landedOid,
      trunkCommitsSinceBase: behindExact,
      aheadOfBase:
        attached && aheadExact !== null ? { count: aheadExact, capped: false } : view.aheadOfBase,
      attached,
      ...(attached
        ? {
            headOid,
            unsynced,
            // The human line distinguishes behind/diverged/ahead; the machine
            // mirror must too, or a JSON caller can't tell a fast-forward from
            // a real divergence.
            syncRelation: relation,
            uncommitted: dirty,
            trunkOverlap,
          }
        : {}),
      overlaps,
    }
    if (!args.json) {
      p.log.info(`Task: ${workspace.task}`)
      p.log.info(
        `Base: ${workspace.baseOid.slice(0, 10)} · ahead ${aheadExact ?? '?'} commit(s) · trunk moved ${behindExact ?? '?'} commit(s) since your base`,
      )
      if (!attached) {
        p.log.info(
          `Not checked out in this clone — showing the published state (local HEAD/uncommitted unavailable). Attach it with \`deepspace workspace attach ${id} <dir>\`.`,
        )
      }
      if (unsynced) {
        // State the RIGHT fact per state: `sync` deterministically refuses on
        // a finished workspace and on a diverged line, so prescribing it
        // unconditionally sends agents into a refusal loop.
        if (workspace.status === 'landed') {
          p.log.info(
            `Already landed${workspace.landedOid ? ` at ${workspace.landedOid.slice(0, 10)}` : ''} — this checkout is a leftover; \`deepspace workspace drop ${id}\` cleans it up.`,
          )
        } else if (workspace.status === 'dropped') {
          p.log.info(
            `Already dropped — this checkout is a leftover; \`deepspace workspace drop ${id}\` cleans it up.`,
          )
        } else if (relation === 'behind') {
          p.log.warn(
            `Local HEAD ${headOid?.slice(0, 10)} is BEHIND the published tip ${view.tipOid?.slice(0, 10)} (another checkout synced ahead) — fast-forward first (\`git pull --no-rebase ${SPACE_REMOTE} ${workspace.ref}\`).`,
          )
        } else if (relation === 'diverged') {
          p.log.warn(
            `Local HEAD ${headOid?.slice(0, 10)} has DIVERGED from the published tip ${view.tipOid?.slice(0, 10)} — integrate it first (\`git pull --no-rebase ${SPACE_REMOTE} ${workspace.ref}\`), then \`deepspace workspace sync\`.`,
          )
        } else {
          // 'ahead' and 'unknown': sync is the right (or only honest) advice.
          p.log.warn(
            `Local HEAD ${headOid?.slice(0, 10)} is not synced (server has ${view.tipOid?.slice(0, 10) ?? 'nothing'}) — run \`deepspace workspace sync\`.`,
          )
        }
      }
      if (dirty.length > 0) p.log.warn(`${dirty.length} uncommitted file(s) in the worktree.`)
      if (trunkOverlap.length > 0) {
        p.log.warn(
          `Trunk also modified: ${trunkOverlap.slice(0, 5).join(', ')}${trunkOverlap.length > 5 ? ` (+${trunkOverlap.length - 5} more)` : ''} — expect merge attention at land time.`,
        )
      }
      printOverlaps(overlaps, false)
    }
    return { data }
  },
})
