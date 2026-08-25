import * as p from '@clack/prompts'
import { defineDeepspaceCommand } from '../../lib/command'
import { isAncestor, listWorktrees, resolveCommit, revListCount } from '../../lib/git/repository'
import { statusFiles } from '../../lib/git/safety'
import { ensureSpaceRemote, runGitRemote, SPACE_REMOTE } from '../../lib/vc-remote'
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
    // A finished workspace's ref is gone (tipOid null), but a checkout whose
    // HEAD is CONTAINED in what was published or landed has nothing
    // unpublished — calling it unsynced sends agents to a sync that
    // deterministically refuses. Containment, not equality: landedOid is the
    // merge commit ON TRUNK, which equals HEAD only when the land ran from
    // this checkout; a workspace landed elsewhere leaves HEAD an ancestor of
    // it. Commits truly beyond the published line still read as unsynced.
    const publishedTip = view.tipOid ?? workspace.landedOid
    // Every relation below is ancestry against the published tip, and that
    // object is routinely absent in exactly the checkout that needs the answer
    // (a peer that never fetched what the author synced) — without it a
    // strictly BEHIND checkout reports "you hold unpublished work" about work
    // it does not have. `--refmap=` leaves the tracking refs untouched.
    if (publishedTip !== null && resolveCommit(appDir, publishedTip) === null) {
      runGitRemote(appDir, token, ['fetch', '--quiet', '--refmap=', SPACE_REMOTE, workspace.ref], {
        allowFail: true,
      })
    }
    const headPublished =
      headOid !== null &&
      publishedTip !== null &&
      (publishedTip === headOid ||
        (workspaceDir !== null &&
          resolveCommit(workspaceDir, publishedTip) !== null &&
          isAncestor(workspaceDir, headOid, publishedTip)))
    const unsynced = headOid !== null && !headPublished
    const dirty = workspaceDir ? statusFiles(workspaceDir) : []

    // One relation drives the human line AND `--json syncRelation` — deriving
    // them separately is how the two surfaces drift apart. Classified by
    // ANCESTRY (the shared predicate), never from `unsynced`: a strictly
    // behind checkout holds nothing unpublished, so an unsynced-gated relation
    // could never reach `behind`. A finished workspace answers `unknown`: its
    // checkout is a leftover, not a line to reconcile.
    const relation =
      workspace.status === 'active' && workspaceDir
        ? workspaceSyncRelation(workspaceDir, headOid, view.tipOid)
        : 'unknown'

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
        // Attaching a FINISHED workspace refuses `workspace_not_active`, so
        // advising it there would prescribe a command that cannot succeed.
        p.log.info(
          workspace.status === 'active'
            ? `Not checked out in this clone — showing the published state (local HEAD/uncommitted unavailable). Attach it with \`deepspace workspace attach ${id} <dir>\`.`
            : `Not checked out in this clone — showing the recorded state (the workspace is ${workspace.status}).`,
        )
      }
      // State the RIGHT fact per state: `sync` deterministically refuses on a
      // finished workspace and on a diverged line, so prescribing it
      // unconditionally sends agents into a refusal loop. A finished
      // workspace's checkout is a leftover whether or not it is "unsynced" —
      // the drop hint must not hide behind that flag.
      if (attached && workspace.status === 'landed') {
        p.log.info(
          `Already landed${workspace.landedOid ? ` at ${workspace.landedOid.slice(0, 10)}` : ''} — this checkout is a leftover; \`deepspace workspace drop ${id}\` cleans it up.` +
            (unsynced
              ? ' It has commits beyond the landed tip — nothing can publish them now.'
              : ''),
        )
      } else if (attached && workspace.status === 'dropped') {
        p.log.info(
          `Already dropped — this checkout is a leftover; \`deepspace workspace drop ${id}\` cleans it up.`,
        )
      } else if (relation === 'behind') {
        // Behind is NOT unsynced — nothing of yours is unpublished — but it is
        // stale, and saying nothing renders a checkout missing a peer's work
        // as perfectly healthy.
        p.log.warn(
          `Local HEAD ${headOid!.slice(0, 10)} is BEHIND the published tip ${view.tipOid!.slice(0, 10)} (another checkout synced ahead) — fast-forward first (\`git pull --no-rebase ${SPACE_REMOTE} ${workspace.ref}\`).`,
        )
      } else if (relation === 'diverged') {
        p.log.warn(
          `Local HEAD ${headOid!.slice(0, 10)} has DIVERGED from the published tip ${view.tipOid!.slice(0, 10)} — integrate it first (\`git pull --no-rebase ${SPACE_REMOTE} ${workspace.ref}\`), then \`deepspace workspace sync\`.`,
        )
      } else if (unsynced) {
        p.log.warn(
          `Local HEAD ${headOid?.slice(0, 10)} is not synced (server has ${view.tipOid?.slice(0, 10) ?? 'nothing'}) — run \`deepspace workspace sync\`.`,
        )
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
