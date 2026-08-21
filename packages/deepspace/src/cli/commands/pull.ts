/**
 * `deepspace pull` — bring cloud-repo history into the local git repo.
 *
 * A real `git fetch` moves what's missing into `.git/objects` and updates
 * the environment-private remote-tracking ref; then integrate
 * conservatively: fast-forward when that's all it takes, otherwise leave the
 * merge to the caller (`git merge refs/remotes/<source>/<branch>` — the objects
 * are already local, so that merge needs no network). Never touches a dirty
 * worktree.
 */

import * as p from '@clack/prompts'
import { realpathSync } from 'node:fs'
import { ensureToken } from '../auth'
import { findAppDir } from '../lib/app-context'
import { noWranglerConfigMessage } from '../lib/wrangler-env'
import { resolveAppTarget, assertAppTargetResolvable } from '../lib/app-target'
import {
  assertNoOperationInProgress,
  assertSyncableRepo,
  checkoutHead,
  currentBranch,
  fastForwardCurrentBranch,
  isAncestor,
  isWorkTreeClean,
  listWorktrees,
  resolveCommit,
  updateRef,
  isPlausibleBranchName,
} from '../lib/git/repository'
import { workspaceIdFromBranch } from '../lib/workspace-id'
import { shQuote } from '../lib/cli-format'
import {
  deployBaseUrl,
  ensureSpaceRemote,
  runGitRemote,
  SPACE_REMOTE,
  spaceTrackingRef,
} from '../lib/vc-remote'
import { repoApi } from '../lib/repo-api'
import { createSpinner } from '../lib/spinner'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import type { CliAction } from '../lib/output'

type Integration =
  | 'up_to_date'
  | 'local_ahead'
  | 'fast_forwarded'
  | 'branch_created'
  | 'fetched_only_diverged'
  | 'fetched_only_dirty'
  | 'fetched_only_unborn'
  | 'fetched_only_worktree'

function targetedVcAction(
  command: 'push' | 'pull',
  cwd: string,
  appId: string,
  branch: string,
): CliAction {
  return {
    cwd,
    argv: ['deepspace', command, '--app', appId, '--branch', branch],
  }
}

function targetedVcCommand(command: 'push' | 'pull', appId: string, branch: string): string {
  return `deepspace ${command} --app ${shQuote(appId)} --branch ${shQuote(branch)}`
}

/** A `ws/<id>` branch is a workspace line, not an ordinary branch: trunk does
 *  not fast-forward into it — it integrates by MERGE, and the two lines stay
 *  distinct until `workspace land`. A plain pull would either bypass that model
 *  or fail confusingly, so refuse with the exact manual merge. Null on any
 *  ordinary branch (no behavior change). Pure + exported for tests. */
export function workspaceBranchPullRefusal(
  branch: string | null,
  trunkBranch: string | null,
): { code: 'workspace_branch'; trunk: string; error: string } | null {
  const id = workspaceIdFromBranch(branch)
  if (!id) return null
  const trunk = trunkBranch || 'main'
  // Git allows branch names with shell metacharacters ($(), ;, &, spaces); quote
  // the interpolated ref so an agent copy-pasting this "run this" line can't
  // shell-expand a collaborator-controlled name. Never a machine contract.
  const merge = `git merge ${spaceTrackingRef(shQuote(trunk))}`
  return {
    code: 'workspace_branch',
    trunk,
    error:
      `"${branch}" is a workspace branch (${id}). Trunk integrates into a workspace by MERGE, not ` +
      `fast-forward — the two lines stay distinct until \`deepspace workspace land\`. Bring trunk in ` +
      `with \`${merge}\` after it is fetched (then resolve/commit), or land the workspace when it's ready.`,
  }
}

/** The path of ANOTHER worktree (not `selfPath`) that has `branch` checked out,
 *  or null. Pull must not move a branch ref while a linked worktree holds it:
 *  that worktree's HEAD would advance while its index and files stay at the old
 *  commit, fabricating deletions/modifications. Pure + exported for tests. */
export function worktreeHoldingBranch(
  worktrees: { path: string; branch: string | null }[],
  branch: string,
  selfPath: string,
): string | null {
  const real = (pth: string): string => {
    try {
      return realpathSync(pth)
    } catch {
      return pth
    }
  }
  const self = real(selfPath)
  for (const w of worktrees) {
    if (w.branch === branch && real(w.path) !== self) return w.path
  }
  return null
}

/**
 * The next-step advice for a diverged pull. `git merge` always merges INTO
 * the checked-out branch. When the selected branch is checked out in ANY
 * worktree, merge there; only an unowned branch needs a checkout first. Pure +
 * exported for tests.
 */
export function divergedMergeAdvice(branch: string, hasSelectedCheckout: boolean): string {
  // Shell-quote the interpolated branch — Git permits $(), ;, &, and spaces in
  // branch names, so an unquoted "run this" line could mis-parse or expand a
  // collaborator-controlled name. Human rendering only, never a machine contract.
  const b = shQuote(branch)
  return hasSelectedCheckout
    ? `git merge ${spaceTrackingRef(b)}`
    : `git checkout ${b} && git merge ${spaceTrackingRef(b)}`
}

export default defineDeepspaceCommand({
  meta: {
    name: 'pull',
    description:
      "Fetch the app's cloud repo and fast-forward the local branch " +
      '(exit 2 only when one executable local continuation remains)',
  },
  args: {
    branch: {
      type: 'string',
      alias: 'b',
      description: 'Branch to pull (default: the current branch)',
      required: false,
    },
    app: {
      type: 'string',
      alias: 'a',
      description:
        'App id or subdomain name (default: DEEPSPACE_APP_ID from the nearest wrangler.toml)',
      required: false,
    },
  },
  async run({ args }) {
    const branchArg = args.branch === undefined ? undefined : String(args.branch)
    const appArg = typeof args.app === 'string' ? args.app : undefined
    const appDir = findAppDir()
    if (!appDir) throw new Refusal(noWranglerConfigMessage(process.cwd()), 'not_in_app_repo')

    // An explicitly-blank --branch must not silently fall back to the current
    // branch (an unset `--branch "$VAR"` would pull the wrong ref). Validate
    // the argument before inspecting repository state so a shallow checkout
    // cannot mask this pre-repository input error.
    if (branchArg !== undefined) {
      const b = branchArg.trim()
      if (!b) throw new Refusal('--branch was given an empty branch name.', 'invalid_branch')
      if (!isPlausibleBranchName(b))
        throw new Refusal(`--branch "${b}" is not a valid git branch name.`, 'invalid_branch')
    }
    assertSyncableRepo(appDir)
    assertNoOperationInProgress(appDir)
    const branch = branchArg?.trim() || currentBranch(appDir)
    if (!branch)
      throw new Refusal(
        'HEAD is detached — pass --branch <name> to choose what to pull.',
        'detached_head',
      )
    const refName = `refs/heads/${branch}`
    const selectedBranchCheckout = (): { onCurrent: boolean; path: string | null } => {
      const onCurrent = currentBranch(appDir) === branch
      return {
        onCurrent,
        path: onCurrent ? appDir : worktreeHoldingBranch(listWorktrees(appDir), branch, appDir),
      }
    }
    const spinner = args.json ? null : createSpinner()
    spinner?.start(`Preparing to pull ${branch}…`)

    // Blank --app / missing app context is a client-side error — reject it
    // BEFORE the token read so it never surfaces as not_authenticated.
    assertAppTargetResolvable(appArg)
    const token = await ensureToken()
    const deployUrl = deployBaseUrl()
    const appId = await resolveAppTarget(deployUrl, token, appArg)

    // JSON refs first: "no repo" and "no such branch" get actionable
    // messages instead of git's couldn't-find-remote-ref stderr — and a
    // GitHub-source app is refused here (the server's 422) BEFORE the `space`
    // remote is written into the user's .git/config. Read-only verbs must not
    // leave a push-capable remote behind on a refusal: with it installed, a
    // raw `git push space` walks around `push`'s own preflight and gets git's
    // bare 422 with no sentence.
    spinner?.message(`Checking the cloud ${branch} ref…`)
    const remote = await repoApi(deployUrl, token, appId).getRefs()
    ensureSpaceRemote(appDir, appId)
    if (!remote) {
      spinner?.stop('No cloud repo yet.')
      const pushCommand = targetedVcCommand('push', appId, branch)
      throw new Refusal(
        `This app has no cloud repo yet — run \`${pushCommand}\` from the repo that has the history.`,
        'no_cloud_repo',
        { action: targetedVcAction('push', appDir, appId, branch) },
      )
    }

    // A workspace branch can't be pulled like an ordinary branch — refuse
    // BEFORE the branch-existence check (its visible ref usually doesn't even
    // exist on the cloud repo, which would otherwise print a confusing "no
    // such branch"). Exit 2 with the one manual merge to run instead.
    const trunkBranch = remote.head?.startsWith('refs/heads/')
      ? remote.head.slice('refs/heads/'.length)
      : null
    const wsRefusal = workspaceBranchPullRefusal(branch, trunkBranch)
    if (wsRefusal) {
      const trunkRef = `refs/heads/${wsRefusal.trunk}`
      const trunkTrackingRef = spaceTrackingRef(wsRefusal.trunk)
      runGitRemote(appDir, token, [
        'fetch',
        '--quiet',
        SPACE_REMOTE,
        `+${trunkRef}:${trunkTrackingRef}`,
      ])
      spinner?.stop('Workspace branch.')
      const { path: branchWorktreePath } = selectedBranchCheckout()
      const workspaceId = workspaceIdFromBranch(branch)
      if (!workspaceId) throw new Error(`Workspace branch did not contain an id: ${branch}`)
      const pullCommand = targetedVcCommand('pull', appId, branch)
      const localBranchExists = resolveCommit(appDir, refName) !== null
      const selectedCheckoutClean =
        branchWorktreePath !== null && isWorkTreeClean(branchWorktreePath)
      const canCheckoutHere =
        branchWorktreePath === null && localBranchExists && isWorkTreeClean(appDir)
      const step = branchWorktreePath
        ? selectedCheckoutClean
          ? `Merge the fetched trunk in the checkout that owns ${branch} (${branchWorktreePath}).`
          : `The checkout that owns ${branch} (${branchWorktreePath}) is dirty. Commit or stash there, then rerun \`${pullCommand}\` from that checkout.`
        : localBranchExists
          ? canCheckoutHere
            ? `The branch is not checked out. Check it out here, then rerun \`${pullCommand}\` to receive the merge step.`
            : `The branch is not checked out and this checkout is dirty. Commit or stash first (or use a clean worktree), check out ${shQuote(branch)}, then rerun \`${pullCommand}\`.`
          : `This clone has not attached the workspace. Attach ${workspaceId}, then rerun \`${pullCommand}\` from its checkout.`
      const action: CliAction | undefined =
        branchWorktreePath && selectedCheckoutClean
          ? {
              cwd: branchWorktreePath,
              argv: ['git', 'merge', trunkTrackingRef],
            }
          : canCheckoutHere
            ? { cwd: appDir, argv: ['git', 'checkout', branch] }
            : !localBranchExists
              ? {
                  cwd: appDir,
                  argv: ['deepspace', 'workspace', 'attach', workspaceId, '--app', appId],
                }
              : undefined
      throw new Refusal(`${wsRefusal.error} ${step}`, wsRefusal.code, {
        actionRequired: action !== undefined,
        action,
        extra: {
          appId,
          branch,
          ...(branchWorktreePath ? { worktreePath: branchWorktreePath } : {}),
        },
      })
    }

    if (!remote.refs.some((r) => r.name === refName)) {
      spinner?.stop('Branch not found.')
      const branches = remote.refs
        .filter((r) => r.name.startsWith('refs/heads/'))
        .map((r) => r.name.slice('refs/heads/'.length))
      throw new Refusal(
        `The cloud repo has no branch "${branch}".` +
          (branches.length ? ` Available: ${branches.join(', ')}.` : ' It is empty — push first.'),
        'branch_not_found',
      )
    }

    // Real git does the transfer; `+` force-updates the tracking ref (a
    // remote-tracking ref always mirrors the remote, rewrites included).
    spinner?.message(`Fetching ${branch} from the cloud repo…`)
    const trackingRef = spaceTrackingRef(branch)
    runGitRemote(appDir, token, ['fetch', '--quiet', SPACE_REMOTE, `+${refName}:${trackingRef}`])
    const remoteOid = resolveCommit(appDir, trackingRef)
    if (!remoteOid) {
      spinner?.stop('Fetch failed.')
      throw new Refusal(
        `Fetched, but ${trackingRef} did not materialize — retry; if it persists, report it with \`deepspace feedback\`.`,
        'fetch_incomplete',
      )
    }

    // Integrate — conservatively.
    // Resolve the owner immediately after fetch, before BOTH fast-forward and
    // divergence handling, so the action reflects the live worktree layout.
    const { onCurrent, path: branchWorktreePath } = selectedBranchCheckout()
    const localOid = resolveCommit(appDir, refName)
    let integration: Integration
    if (localOid === remoteOid) {
      integration = 'up_to_date'
    } else if (localOid === null) {
      // The branch doesn't exist locally yet. Creating the ref is always
      // safe; materializing the worktree only is when nothing can collide.
      updateRef(appDir, refName, remoteOid)
      if (onCurrent && isWorkTreeClean(appDir)) {
        checkoutHead(appDir)
        integration = 'branch_created'
      } else {
        integration = onCurrent ? 'fetched_only_unborn' : 'branch_created'
      }
    } else if (isAncestor(appDir, localOid, remoteOid)) {
      if (onCurrent) {
        if (!isWorkTreeClean(appDir)) {
          integration = 'fetched_only_dirty'
        } else {
          fastForwardCurrentBranch(appDir, remoteOid)
          integration = 'fast_forwarded'
        }
      } else {
        // Fast-forwarding a NON-current branch writes its ref directly — but
        // if another linked worktree has it checked out, moving the ref
        // desyncs that worktree (its HEAD advances while its index/files stay
        // put, fabricating deletions). Leave the ref alone and send the agent
        // to pull from that worktree instead.
        if (branchWorktreePath) {
          integration = 'fetched_only_worktree'
        } else {
          updateRef(appDir, refName, remoteOid)
          integration = 'fast_forwarded'
        }
      }
    } else if (isAncestor(appDir, remoteOid, localOid)) {
      // Local already CONTAINS the cloud tip — ordinary unpushed work, not a
      // divergence. There is nothing to integrate, so the fetch succeeded and
      // the next step is `push`. Lumping this in with divergence below issued
      // exit 2 plus `git merge <tracking-ref>`, which answers "Already up to
      // date" and leaves the state untouched — an agent honouring the exit-2
      // contract re-ran pull forever. `status` has always classified this
      // correctly; the two now agree.
      integration = 'local_ahead'
    } else {
      integration = 'fetched_only_diverged'
    }

    // Render the integration once, exhaustively. Summary, refusal code, and
    // structured action belong to the same outcome branch so they cannot drift.
    const qBranch = shQuote(branch)
    const ffRef = `git merge --ff-only ${spaceTrackingRef(qBranch)}`
    const mergeRef = `git merge ${spaceTrackingRef(qBranch)}`
    const pullCommand = targetedVcCommand('pull', appId, branch)
    const pushCommand = targetedVcCommand('push', appId, branch)
    const selectedCheckoutClean = branchWorktreePath !== null && isWorkTreeClean(branchWorktreePath)
    const canCheckoutHere = branchWorktreePath === null && isWorkTreeClean(appDir)
    let line: string
    let codeForState: string | undefined
    let recoveryAction: CliAction | undefined
    let successAction: CliAction | undefined
    switch (integration) {
      case 'up_to_date':
        line = `${branch} is already up to date.`
        break
      case 'local_ahead':
        // Success, not a refusal: nothing to receive. Exit 0 may still carry
        // the one deterministic continuation, just like other successful
        // command results in the shared output contract.
        line =
          `${branch} already contains ${SPACE_REMOTE}/${branch} at ${remoteOid.slice(0, 10)} — ` +
          `nothing to pull. Local work is not on the cloud repo yet: run \`${pushCommand}\`.`
        successAction = targetedVcAction('push', appDir, appId, branch)
        break
      case 'fast_forwarded':
        line = `Fast-forwarded ${branch} to ${remoteOid.slice(0, 10)}.`
        break
      case 'branch_created':
        line = `Created ${branch} at ${remoteOid.slice(0, 10)}.`
        break
      case 'fetched_only_diverged':
        codeForState = 'diverged'
        if (branchWorktreePath && selectedCheckoutClean) {
          const mergeAdvice = divergedMergeAdvice(branch, true)
          line =
            `Fetched ${SPACE_REMOTE}/${branch}. ${branch} and the cloud repo diverged — run ` +
            `\`${mergeAdvice}\` in ${branchWorktreePath} (no network needed), then \`${pushCommand}\`.`
          recoveryAction = {
            cwd: branchWorktreePath,
            argv: ['git', 'merge', trackingRef],
          }
        } else if (branchWorktreePath) {
          line =
            `Fetched ${SPACE_REMOTE}/${branch}. ${branch} and the cloud repo diverged, but its checkout ` +
            `(${branchWorktreePath}) is dirty. Commit or stash there, then rerun ` +
            `\`${pullCommand}\` from that checkout.`
        } else if (canCheckoutHere) {
          line =
            `Fetched ${SPACE_REMOTE}/${branch}. ${branch} and the cloud repo diverged, but ${branch} is ` +
            `not checked out. Check it out here, then rerun \`${pullCommand}\` to receive the merge step.`
          recoveryAction = { cwd: appDir, argv: ['git', 'checkout', branch] }
        } else {
          line =
            `Fetched ${SPACE_REMOTE}/${branch}. ${branch} and the cloud repo diverged, but ${branch} is ` +
            `not checked out and this checkout is dirty. Commit or stash first (or use a clean ` +
            `worktree), check out ${qBranch}, then rerun \`${pullCommand}\`.`
        }
        break
      case 'fetched_only_dirty':
        codeForState = 'dirty_worktree'
        // A commit diverges the branch, while a stash preserves fast-forward.
        line =
          `Fetched ${SPACE_REMOTE}/${branch}, but the worktree is dirty. Either stash → \`${ffRef}\` → ` +
          `\`git stash pop\`, or commit first → \`${mergeRef}\` (or \`git rebase\`).`
        break
      case 'fetched_only_unborn':
        codeForState = 'dirty_worktree'
        line =
          `Fetched ${SPACE_REMOTE}/${branch} and created ${branch}, but the worktree has uncommitted files. ` +
          `Preserve them in a commit or stash (including untracked files), then restore the checkout; ` +
          `do not run reset --hard until \`git status\` confirms nothing worth keeping remains.`
        break
      case 'fetched_only_worktree':
        codeForState = 'branch_in_worktree'
        if (branchWorktreePath && selectedCheckoutClean) {
          line =
            `Fetched ${SPACE_REMOTE}/${branch}, but ${branch} is checked out in another worktree ` +
            `(${branchWorktreePath}) — its ref was left untouched to keep that worktree in sync. ` +
            `Run \`${pullCommand}\` from there.`
          recoveryAction = targetedVcAction('pull', branchWorktreePath, appId, branch)
        } else {
          line =
            `Fetched ${SPACE_REMOTE}/${branch}, but its checkout ` +
            `(${branchWorktreePath ?? 'a linked worktree'}) is dirty, so the ref and worktree were ` +
            `left untouched. Commit or stash there, then run \`${pullCommand}\` from that checkout.`
        }
        break
      default: {
        const exhaustive: never = integration
        throw new Error(`Unhandled pull integration: ${exhaustive}`)
      }
    }
    // Exit 2 is reserved for a single executable continuation. Dirty or
    // unavailable checkout states require judgment and remain ordinary,
    // actionless refusals even though the fetch itself succeeded.
    const actionRequired = recoveryAction !== undefined
    spinner?.stop(codeForState ? `Fetched ${SPACE_REMOTE}/${branch}.` : line)
    // Completeness: appId and the fetched remote oid are --json facts the
    // summary line doesn't always carry — say them in the text too.
    if (!args.json)
      p.log.info(`App: ${appId} · ${SPACE_REMOTE}/${branch} at ${remoteOid.slice(0, 10)}`)
    if (codeForState) {
      // Every blocked integration is ok:false. Only one with an executable
      // continuation adds actionRequired and exits 2; judgment states exit 1.
      throw new Refusal(line, codeForState, {
        actionRequired,
        action: recoveryAction,
        extra: {
          status: integration,
          ...(branchWorktreePath ? { worktreePath: branchWorktreePath } : {}),
          appId,
          branch,
          remoteOid,
        },
      })
    }
    return { data: { status: integration, appId, branch, remoteOid }, action: successAction }
  },
})
