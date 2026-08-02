import { ensureToken } from '../../auth'
import { findAppDir } from '../../lib/app-context'
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
      'No wrangler.toml found — run from inside an app directory (or use -a <app> for list, and for drop with an explicit ws_ id).',
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
      'Not inside a workspace worktree (the branch is not ws/<id>). Pass the workspace id, or create one with `deepspace workspace new -t "…"`.',
      'not_in_workspace',
    )
  }
  if (!isWorkspaceId(id)) {
    throw new Refusal(`Invalid workspace id: ${id} (expected ws_<ULID>).`, 'invalid_workspace')
  }
  return id
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
  const action: CliAction = worktree
    ? { cwd: worktree, argv: resumeArgv }
    : { cwd: appDir, argv: ['deepspace', 'workspace', 'attach', id] }
  throw new Refusal(
    `Workspace ${id} is not checked out here (current branch: ${branch ?? 'detached'}). ` +
      (worktree
        ? `Run this command from its checkout at ${worktree}.`
        : 'Attach it in this clone before mutating its published line.'),
    'workspace_checkout_mismatch',
    {
      action,
      extra: worktree ? { workspaceDir: worktree } : undefined,
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
    throw new Refusal(
      `Another checkout advanced this workspace's line, so publishing yours is not a ` +
        `fast-forward — the push was refused rather than drop that work. Integrate its tip ` +
        `(\`git pull ${SPACE_REMOTE} ${ref}\`, or re-attach the workspace in a fresh dir), ` +
        `resolve any conflicts, then re-run the command. (Amended or rebased your own ` +
        `commits? Same refusal — merge your old tip back in.)`,
      push.status,
      {
        action: { cwd: appDir, argv: ['git', 'pull', SPACE_REMOTE, ref] },
      },
    )
  }
  throw new Refusal(pushFailureMessage('Workspace upload', push, appDir), push.status)
}
