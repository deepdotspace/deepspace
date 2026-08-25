import { ensureToken } from '../../auth'
import { findAppDir } from '../../lib/app-context'
import { noWranglerConfigMessage } from '../../lib/wrangler-env'
import { resolveAppTarget, parseAppArg, assertAppTargetResolvable } from '../../lib/app-target'
import { Refusal } from '../../lib/command'
import type { CliAction } from '../../lib/output'
import {
  assertSyncableRepo,
  currentBranch,
  interruptedGitOperation,
  isAncestor,
  listWorktrees,
  resolveCommit,
} from '../../lib/git/repository'
import { committedSecretRefusal, unmergedIndexRefusal } from '../../lib/git/safety'
import {
  isSelectedWorkspaceCheckout,
  isWorkspaceId,
  resolveWorkspaceWorktree,
  workspaceIdFromBranch,
} from '../../lib/workspace-id'
import { classifyRejection, pushFailureMessage, pushToSpace } from '../../lib/vc-push'
import { deployBaseUrl, SPACE_REMOTE } from '../../lib/vc-remote'
import { repoApi, type RepoApi } from '../../lib/repo-api'
import { appDirInWorktree } from './local'

export const APP_ARG = {
  type: 'string' as const,
  alias: 'a',
  description:
    'App id or subdomain name (default: DEEPSPACE_APP_ID from the nearest wrangler.toml)',
  required: false,
}

interface Target {
  appDir: string
  appId: string
  token: string
  api: RepoApi
}

export async function resolveTarget(appArg: string | undefined): Promise<Target> {
  const appDir = findAppDir()
  if (!appDir) {
    throw new Refusal(
      `${noWranglerConfigMessage(process.cwd())} (Or use -a <app> for list, and for drop with an explicit ws_ id.)`,
      'not_in_app_repo',
    )
  }
  const { error: appErr } = parseAppArg(appArg)
  if (appErr) throw new Refusal(appErr, 'invalid_app')
  assertSyncableRepo(appDir)
  assertAppTargetResolvable(appArg)
  const token = await ensureToken()
  const appId = await resolveAppTarget(deployBaseUrl(), token, appArg)
  return { appDir, appId, token, api: repoApi(deployBaseUrl(), token, appId) }
}

/** Server-only resolution for list-style reads, including calls outside a checkout. */
export async function resolveApiOnly(
  appArg: string | undefined,
): Promise<{ appId: string; api: RepoApi; token: string }> {
  assertAppTargetResolvable(appArg)
  const token = await ensureToken()
  const appId = await resolveAppTarget(deployBaseUrl(), token, appArg)
  return { appId, api: repoApi(deployBaseUrl(), token, appId), token }
}

export function inferWorkspaceId(appDir: string, explicit: string | undefined): string {
  const id = explicit?.trim() || workspaceIdFromBranch(currentBranch(appDir))
  if (!id) {
    // ONLY when HEAD is actually detached. A rebase (or a bisect) detaches it,
    // so the branch stops naming the workspace even though this IS its
    // worktree — and the generic advice, "create one with `workspace new`",
    // would spawn a second workspace and strand this one.
    //
    // A conflicted MERGE or CHERRY-PICK does not detach: HEAD still points at
    // the branch. Firing there would replace a correct `not_in_workspace` (you
    // really are on `main`) with a refusal asserting a detachment that has not
    // happened, whose "abort, then re-run" leaves you refusing again.
    const interrupted = currentBranch(appDir) === null ? interruptedGitOperation(appDir) : null
    if (interrupted) {
      // `git bisect` has no --continue/--abort; `reset` is its verb.
      const finish =
        interrupted === 'bisect'
          ? 'end it (`git bisect reset`)'
          : `finish it (\`git ${interrupted} --continue\`) or abandon it (\`git ${interrupted} --abort\`)`
      throw new Refusal(
        `A ${interrupted} is in progress here, so HEAD is detached and the branch no longer names a workspace. ${finish[0].toUpperCase()}${finish.slice(1)}, then re-run — the workspace is unchanged either way.`,
        'git_operation_in_progress',
        { extra: { operation: interrupted } },
      )
    }
    throw new Refusal(
      'Not inside a workspace worktree (the branch is not ws/<id>). Select one with `-w ws_…` (for `workspace drop`, pass the id as the argument), or create one with `deepspace workspace new -t "…"`.',
      'not_in_workspace',
    )
  }
  if (!isWorkspaceId(id)) {
    throw new Refusal(`Invalid workspace id: ${id} (expected ws_<ULID>).`, 'invalid_workspace')
  }
  return id
}

/** A finished workspace refuses a mutating verb the same way everywhere.
 *  When the caller stands in (or near) the leftover checkout, `dropAction`
 *  points at the one verb that resolves this state — `workspace drop` cleans
 *  the leftover up. Exit stays 1: nothing was mutated, the action is advice. */
export function workspaceNotActiveRefusal(
  id: string,
  status: string,
  dropAction?: CliAction,
): Refusal {
  return new Refusal(
    `Workspace ${id} is already ${status}.` +
      (dropAction ? ' This checkout is a leftover — `deepspace workspace drop` cleans it up.' : ''),
    'workspace_not_active',
    {
      ...(dropAction ? { action: dropAction } : {}),
      extra: { workspaceId: id, status },
    },
  )
}

/** Mutating verbs must run from the selected workspace's own checkout. */
export function assertSelectedWorkspaceCheckout(
  appDir: string,
  id: string,
  resumeArgv: string[],
): void {
  const branch = currentBranch(appDir)
  if (isSelectedWorkspaceCheckout(branch, id)) return
  const worktree = resolveWorkspaceWorktree(listWorktrees(appDir), id)
  // The app dir INSIDE the worktree, not its root: commands resolve the app
  // by walking UP from cwd, so an app in a subdirectory is invisible from
  // the worktree root.
  const worktreeAppDir = worktree ? appDirInWorktree(appDir, worktree) : null
  const action: CliAction = worktreeAppDir
    ? { cwd: worktreeAppDir, argv: resumeArgv }
    : { cwd: appDir, argv: ['deepspace', 'workspace', 'attach', id] }
  throw new Refusal(
    `Workspace ${id} is not checked out here (current branch: ${branch ?? 'detached'}). ` +
      (worktreeAppDir
        ? `Run this command from its checkout at ${worktreeAppDir}.`
        : 'Attach it in this clone before mutating its published line.'),
    'workspace_checkout_mismatch',
    {
      action,
      extra: worktreeAppDir ? { workspaceDir: worktreeAppDir } : undefined,
    },
  )
}

/** Reject malformed explicit ids before auth/network. */
export function assertExplicitWorkspaceId(explicit: string | undefined): void {
  if (explicit === undefined) return
  const id = explicit.trim()
  if (!id || !isWorkspaceId(id)) {
    throw new Refusal(
      `Invalid workspace id: ${explicit} (expected ws_<ULID>).`,
      'invalid_workspace',
    )
  }
}

/** Publish a workspace line with Git's fast-forward rule as the lost-update guard.
 *  `publishedTip` (the server's recorded tip, when the caller holds it) lets
 *  the refusal say which situation the checkout is actually in. */
export function pushWorkspaceRef(
  appDir: string,
  token: string,
  ref: string,
  headOid: string,
  publishedTip?: string | null,
): void {
  const secret = committedSecretRefusal(appDir, headOid, {
    action: 'publish this workspace',
    then: 're-run the command',
    // What the cloud already has for this ref, so the scan covers every commit
    // this publish would upload — which is what the server scans.
    base: publishedTip ?? null,
  })
  if (secret) throw new Refusal(secret.message, secret.code)

  const push = pushToSpace(appDir, token, `${headOid}:${ref}`)
  if (push.status === 'committed' || push.status === 'up_to_date') return
  if (push.status === 'ref_conflict' || push.status === 'non_fast_forward') {
    // The recovery below is `git pull`, which git refuses outright while the
    // index carries unmerged entries. Checked HERE, not before the push: a
    // checkout that only needs to fast-forward the remote publishes fine
    // mid-conflict. No `action`: the work is manual, the shape
    // `dirty_worktree` uses.
    const conflicted = unmergedIndexRefusal(appDir, {
      ours: "The merge this workspace's last pull started",
      resume: 'the command',
    })
    if (conflicted) {
      throw new Refusal(conflicted.message, conflicted.code, {
        extra: { conflict: true, operation: conflicted.operation },
      })
    }
    // A checkout that is strictly BEHIND holds nothing unpublished, so "the
    // push was refused rather than drop that work" sends it hunting for work
    // it does not have. Say which case this is whenever we can prove it.
    const strictlyBehind =
      typeof publishedTip === 'string' &&
      resolveCommit(appDir, publishedTip) !== null &&
      isAncestor(appDir, headOid, publishedTip)
    // `--no-rebase` matters: a fresh clone has no pull.rebase/pull.ff config,
    // and a divergent pull without it dies asking how to reconcile — the one
    // executable action must run as-is.
    throw new Refusal(
      strictlyBehind
        ? `Another checkout already synced ahead of this one — nothing of yours is ` +
          `unpublished; this checkout is just behind. Fast-forward it ` +
          `(\`git pull --no-rebase ${SPACE_REMOTE} ${ref}\`), then re-run the command.`
        : `Another checkout advanced this workspace's line, so publishing yours is not a ` +
          `fast-forward — the push was refused rather than drop that work. Integrate its tip ` +
          `(\`git pull --no-rebase ${SPACE_REMOTE} ${ref}\`, or re-attach the workspace in a ` +
          `fresh dir), resolve any conflicts, then re-run the command. (Amended or rebased ` +
          `your own commits? Same refusal — merge your old tip back in.)`,
      push.status,
      {
        actionRequired: true,
        action: { cwd: appDir, argv: ['git', 'pull', '--no-rebase', SPACE_REMOTE, ref] },
      },
    )
  }
  // `classifyRejection` owns the reason→code mapping, and `pushFailureMessage`
  // reads the same call for its sentence — so a size-capped workspace publish
  // reports `push_too_large` here exactly as `deepspace push` does, rather than
  // the catch-all `rejected`.
  const code =
    push.status === 'rejected'
      ? classifyRejection(push.reason ?? push.summary ?? '', appDir).code
      : push.status
  throw new Refusal(pushFailureMessage('Workspace upload', push, appDir), code)
}
