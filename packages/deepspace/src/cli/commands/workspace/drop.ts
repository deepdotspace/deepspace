import * as p from '@clack/prompts'
import { findAppDir } from '../../lib/app-context'
import { errorCode } from '../../lib/cli-errors'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import { isAncestor, isWorkTreeClean, resolveCommit } from '../../lib/git/repository'
import { unmergedIndexRefusal } from '../../lib/git/safety'
import type { CliAction } from '../../lib/output'
import { humanCommand } from '../../lib/cli-format'
import { ensureSpaceRemote, runGitRemote, SPACE_REMOTE } from '../../lib/vc-remote'
import { workspaceSyncRelation } from './analysis'
import type { RemoteWorkspace, RemoteWorkspaceView, RepoApi } from '../../lib/repo-api'
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
  /** Server-side workspace status — a FINISHED workspace can never publish
   *  again, so prescribing `sync` here ping-pongs forever with sync's own
   *  `workspace_not_active` → drop advice. */
  status: RemoteWorkspace['status']
}): Refusal {
  const dropArgv = ['deepspace', 'workspace', 'drop', args.id, '--app', args.appId]
  if (args.status !== 'active') {
    // A finished workspace can never publish these commits — `sync` refuses
    // it — so prescribing the publish path would be the dead end this verb
    // exists to remove. NO action either: `--keep-worktree` still reaps the
    // cloud workspace, so it is not a "keep everything" step, and retain vs
    // discard is the caller's choice, not one command.
    const keepArgv = [...dropArgv, '--keep-worktree']
    return new Refusal(
      `${args.id} is already ${args.status} on the server, and this checkout holds commits that ` +
        `nothing in the cloud represents any more — nothing can publish them now. ` +
        `\`${humanCommand(keepArgv)}\` drops the cloud workspace but retains the local ` +
        `branch/worktree for manual disposal, or delete the branch yourself. Nothing was dropped.`,
      'workspace_unsynced',
      { extra: { workspaceId: args.id, status: args.status } },
    )
  }
  const syncArgv = ['deepspace', 'workspace', 'sync', '--app', args.appId, '--workspace', args.id]
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
    'abandon-unseen': {
      type: 'boolean',
      description:
        'Drop even though this checkout has not seen the published tip — an explicit decision to abandon commits you have not read (workspace_behind)',
      default: false,
    },
    app: APP_ARG,
  },
  async run({ args }) {
    const explicitId = typeof args.id === 'string' ? args.id.trim() : undefined
    assertExplicitWorkspaceId(explicitId)
    const appArg = typeof args.app === 'string' ? args.app : undefined
    const keepWorktree = Boolean(args['keep-worktree'])
    const abandonUnseen = Boolean(args['abandon-unseen'])
    const spinner = args.json ? null : createSpinner()
    spinner?.start(`Preparing to drop ${explicitId ?? 'workspace'}…`)
    // ONE path, with or without a local checkout. Outside one an explicit id is
    // the whole address — there is nothing local to infer from, compare
    // against, or clean up — and with no id either, `resolveTarget` owns the
    // "run this from an app directory" refusal.
    const inCheckout = findAppDir() !== null || !explicitId
    const { appDir, appId, token, api } = inCheckout
      ? await resolveTarget(appArg)
      : { appDir: null, ...(await resolveApiOnly(appArg)) }
    // `inCheckout` is false only when an explicit id was given.
    const id = appDir ? inferWorkspaceId(appDir, explicitId) : explicitId!
    const inspection = appDir ? inspectWorkspaceCleanup(appDir, id) : null
    let approvedBranchOid: string | undefined
    const { view: before } = await api.getWorkspace(id)
    // Dropping reaps the PUBLISHED line, so this guard protects the CLOUD side
    // and sits OUTSIDE the local-ownership condition below. It applies to every
    // seat, a checkout-less one included: seeing nothing is the weakest
    // position, not a licence to drop. `--abandon-unseen` is the only waiver.
    if (before.workspace.status === 'active' && before.tipOid !== null) {
      // The fetch lives OUTSIDE the refusal condition on purpose: the second
      // guard's containment proof needs this object too, so skipping it with
      // `--abandon-unseen` used to make that guard fail with a false
      // "isn't published yet" — the escape only escaped if you first
      // triggered the refusal you were escaping.
      if (appDir) {
        // The recovery is a `git pull` IN this checkout, so the token goes in:
        // it needs the remote configured and an identity to write the merge
        // commit, or the one command we hand back dies where we told the user
        // to run it.
        ensureSpaceRemote(appDir, appId, undefined, token)
        if (resolveCommit(appDir, before.tipOid) === null) {
          runGitRemote(
            appDir,
            token,
            ['fetch', '--quiet', '--refmap=', SPACE_REMOTE, before.workspace.ref],
            { allowFail: true },
          )
        }
      }
      // 'unknown' with no local branch — and with no checkout at all.
      const relation = workspaceSyncRelation(appDir, inspection?.branchOid ?? null, before.tipOid)
      if (!abandonUnseen && relation !== 'in_sync' && relation !== 'ahead') {
        const pullArgv = ['git', 'pull', '--no-rebase', SPACE_REMOTE, before.workspace.ref]
        const attachArgv = ['deepspace', 'workspace', 'attach', id, '--app', appId]
        // `--abandon-unseen` is named in the PROSE and never handed back as
        // the action. The action is what an agent runs verbatim on the first
        // retry, and this refusal exists to stop exactly that: pointing it at
        // the destructive bypass turned the guard into a one-hop speed bump.
        // The escape stays a decision a human types.
        const abandonCommand = humanCommand([
          'deepspace',
          'workspace',
          'drop',
          id,
          '--app',
          appId,
          '--abandon-unseen',
        ])
        // Only name the pull when there is a worktree to run it in: in a
        // branch-only clone that command runs against the CURRENT branch and
        // fast-forwards trunk onto the workspace line.
        const worktreeDir = inspection?.checkout.dir ?? null
        throw new Refusal(
          `Dropping ${id} would discard its published tip ${before.tipOid.slice(0, 10)}, which ` +
            `this seat has not read (${relation}) — integrate it first, or run ` +
            `\`${abandonCommand}\` to abandon it unread. Nothing was dropped.`,
          'workspace_behind',
          {
            action: worktreeDir
              ? { cwd: worktreeDir, argv: pullArgv }
              : appDir
                ? { cwd: appDir, argv: attachArgv }
                : undefined,
            extra: {
              workspaceId: id,
              publishedTip: before.tipOid,
              localTip: inspection?.branchOid ?? null,
              relation,
            },
          },
        )
      }
    }

    // External Git/Codex/Claude worktrees are retained by cleanup, so only a
    // branch that default cleanup actually owns needs LOCAL publication proof.
    if (appDir && inspection && !keepWorktree && inspection.willDeleteBranch && inspection.branchOid) {
      const publishedOids = [
        // A FINISHED workspace's own ref is being reaped — it can prove
        // nothing. Only trunk (landed) or the pre-existing base counts, or a
        // dropped workspace's last local copy gets deleted on the strength of
        // the very ref that is going away.
        ...(before.workspace.status === 'active' ? [before.tipOid] : []),
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

    const cleanupDir = inspection?.willDeleteBranch ? inspection.checkout.dir : null
    if (!keepWorktree && cleanupDir && !isWorkTreeClean(cleanupDir)) {
      const dropArgv = ['deepspace', 'workspace', 'drop', id, '--app', appId]
      const dropNext = humanCommand(dropArgv)
      // "Commit them" over an UNMERGED index commits the <<<<<<< markers —
      // and following this refusal's own chain then published them to the
      // workspace ref, where a peer sees them. Same guard `land` and
      // `review merge` use; the class is "any verb that tells you to commit".
      const conflicted = unmergedIndexRefusal(cleanupDir, {
        ours: 'A merge',
        resume: dropNext,
      })
      if (conflicted) {
        throw new Refusal(
          `${conflicted.message} Or pass \`--keep-worktree\` to drop the workspace while retaining this checkout. Nothing was dropped.`,
          conflicted.code,
          { extra: { workspaceId: id, conflict: true, operation: conflicted.operation } },
        )
      }
      throw new Refusal(
        `The workspace checkout has uncommitted changes and cleanup would remove it or switch it off ${inspection!.branch}. Commit them and re-run \`${dropNext}\`, or pass \`--keep-worktree\` to drop while retaining the checkout. Nothing was dropped.`,
        'dirty_worktree',
        { extra: { workspaceId: id } },
      )
    }

    // A workspace already landed (from another checkout, say) has nothing to
    // drop remotely — but this stale worktree is still worth cleaning up, and
    // no other verb owns that. The publication proof above already accepted
    // the local tip against the landed history, so cleanup is safe.
    // Re-read: the guards above may have taken a while, and `remoteDropped`
    // must reflect the status the drop call actually raced. Re-dropping
    // replays server-side, so this pre-drop status decides the report —
    // otherwise a no-op replay claims a fresh drop.
    const statusBefore = (await api.getWorkspace(id)).view.workspace.status
    const { view, remoteDropped } = await dropRemoteTolerant(api, id, statusBefore)
    if (appDir && !keepWorktree) spinner?.message(`Cleaning up ${id} locally…`)
    const cleanup =
      appDir && inspection && !keepWorktree
        ? cleanupWorkspaceLocal(appDir, id, null, {
            expectedBranchOid: approvedBranchOid,
            retainLocal: !inspection.willDeleteBranch,
          })
        : null
    const retainedWorktree =
      cleanup?.worktreeRetained ?? (keepWorktree ? (inspection?.checkout.dir ?? null) : null)
    // A clone with no local copy of the line cannot be BEHIND anything, so
    // the guard above has nothing to compare and correctly lets the drop
    // through — but the tip it reaped still deserves to be said out loud,
    // not discovered later by whoever wrote it.
    // Report the abandoned tip whenever this seat could not prove it had read
    // it — including (especially) when the user explicitly ordered the
    // discard, where the exact OID is known and was suppressed before.
    const discardedTip =
      remoteDropped && before.tipOid && (!inspection?.branchOid || abandonUnseen)
        ? before.tipOid
        : null
    const data = {
      workspaceId: id,
      status: view.workspace.status,
      remoteDropped,
      ...(discardedTip ? { discardedTip } : {}),
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
          : `Workspace ${id} was already ${statusBefore} on the server — nothing to drop remotely.`,
      )
      if (discardedTip) {
        p.log.warn(
          `The published tip ${discardedTip.slice(0, 10)} was abandoned unread — this seat could ` +
            `not prove it had read it. Its ref is retained briefly if that was a mistake.`,
        )
      }
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
