import { ensureToken } from '../../auth'
import { findAppDir } from '../../lib/app-context'
import { noWranglerConfigMessage } from '../../lib/wrangler-env'
import { resolveAppTarget, parseAppArg, assertAppTargetResolvable } from '../../lib/app-target'
import { Refusal } from '../../lib/command'
import type { CliAction } from '../../lib/output'
import { assertSyncableRepo, currentBranch, listWorktrees } from '../../lib/git/repository'
import { committedSecretRefusal } from '../../lib/git/safety'
import {
  isSelectedWorkspaceCheckout,
  isWorkspaceId,
  resolveWorkspaceWorktree,
  workspaceIdFromBranch,
} from '../../lib/workspace-id'
import { pushFailureMessage, pushToSpace } from '../../lib/vc-push'
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

/** Publish a workspace line with Git's fast-forward rule as the lost-update guard. */
export function pushWorkspaceRef(
  appDir: string,
  token: string,
  ref: string,
  headOid: string,
): void {
  const secret = committedSecretRefusal(appDir, headOid, {
    action: 'publish this workspace',
    then: 're-run the command',
  })
  if (secret) throw new Refusal(secret.message, secret.code)

  const push = pushToSpace(appDir, token, `${headOid}:${ref}`)
  if (push.status === 'committed' || push.status === 'up_to_date') return
  if (push.status === 'ref_conflict' || push.status === 'non_fast_forward') {
    // `--no-rebase` matters: a fresh clone has no pull.rebase/pull.ff config,
    // and a divergent pull without it dies asking how to reconcile — the one
    // executable action must run as-is.
    throw new Refusal(
      `Another checkout advanced this workspace's line, so publishing yours is not a ` +
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
  throw new Refusal(pushFailureMessage('Workspace upload', push, appDir), push.status)
}
