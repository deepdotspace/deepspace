/**
 * `deepspace push` — sync local git history to the app's cloud repo.
 *
 * The cloud repo is the platform-native remote every DeepSpace app gets,
 * keyed by its immutable app id: collaborators pull/clone from it without
 * GitHub, and DeepSpace-source deploys link releases to its commits. GitHub-
 * source deploys retain their traditional local-working-tree behavior.
 * Local work stays plain `git` — this command only moves committed history,
 * and the transfer itself IS `git push` (the wrapper adds app resolution,
 * auth injection, and machine-readable output).
 *
 * Fast-forward only by default (like git). `deepspace push --force` is GUARDED
 * (see run()): it refuses a force that would orphan a peer's committed work. That
 * guard is CLIENT-SIDE, though — a plain `git push --force space` through the
 * installed credential helper bypasses it, and the server ref-CAS does NOT reject
 * a force (git relearns the advertised old-oid). Fully preventing a force-clobber
 * would require server-side enforcement in the deploy worker.
 */

import * as p from '@clack/prompts'
import { ensureToken } from '../auth'
import { ApiError } from '../lib/api'
import { getAppSource } from '../lib/source-api'
import { findAppDir } from '../lib/app-context'
import { resolveAppTarget, warnIfPhantomApp, assertAppTargetResolvable } from '../lib/app-target'
import {
  assertSyncableRepo,
  currentBranch,
  isAncestor,
  isPlausibleBranchName,
  listWorktrees,
  resolveCommit,
  updateRef,
} from '../lib/git/repository'
import { SECRET_IN_HISTORY_CODE, trackedSecretFiles } from '../lib/git/safety'
import { workspaceIdFromBranch } from '../lib/workspace-id'
import { shQuote } from '../lib/cli-format'
import {
  classifyPushTransportFailure,
  isRecoverablePushFailure,
  PUSH_CEILINGS,
  pushFailureMessage,
  pushToSpace,
} from '../lib/vc-push'
import {
  deployBaseUrl,
  ensureSpaceRemote,
  runGitRemote,
  SPACE_REMOTE,
  spacePrivateRef,
} from '../lib/vc-remote'
import { createSpinner } from '../lib/spinner'
import { defineDeepspaceCommand, Refusal } from '../lib/command'
import type { CliAction } from '../lib/output'

function pullRecoveryAction(cwd: string, appId: string, branch: string): CliAction {
  return {
    cwd,
    argv: ['deepspace', 'pull', '--app', appId, '--branch', branch],
  }
}

function selectedBranchCheckout(appDir: string, branch: string): string | null {
  if (currentBranch(appDir) === branch) return appDir
  return listWorktrees(appDir).find((worktree) => worktree.branch === branch)?.path ?? null
}

/**
 * Whether a `--force` push of `tipOid` onto a branch would ORPHAN work — i.e.
 * drop commits that only the current remote tip holds. Refuse (true) unless the
 * force is safe: the remote tip is unset (first publish), equals the tip (up to
 * date), equals our own last-pushed record (a rewrite of our OWN line — the
 * legitimate reason to force), or is already CONTAINED in the tip (a normal
 * advance / we integrated it). Any other remote tip = a peer advanced the
 * branch to commits we lack, so forcing would silently lose their work. Pure —
 * the ancestry test (`tipContainsRemoteTip`) is injected so this is
 * unit-testable.
 */
export function forcePushOrphansWork(
  lastPushed: string | null,
  remoteTip: string | null,
  tipOid: string,
  tipContainsRemoteTip: boolean,
): boolean {
  if (remoteTip === null) return false // no remote line yet — first publish
  if (remoteTip === tipOid) return false // already up to date
  if (remoteTip === lastPushed) return false // rewrite of our own line (no peer advance)
  return !tipContainsRemoteTip // else safe only if the tip already contains it
}

/** A `ws/<id>` branch is a workspace line: a plain push writes the visible
 *  `refs/heads/ws/<id>` while `workspace sync` publishes the hidden coordination
 *  ref AND records metadata. Pushing here looks successful yet leaves the
 *  workspace tip, overlap warnings, and activity stale — so refuse and send the
 *  agent to sync. Null on any ordinary branch (no behavior change). Pure +
 *  exported for tests. */
export function workspaceBranchPushRefusal(
  branch: string | null,
): { code: 'workspace_branch'; error: string } | null {
  const id = workspaceIdFromBranch(branch)
  if (!id) return null
  return {
    code: 'workspace_branch',
    error:
      `"${branch}" is a workspace branch (${id}). A plain push moves only the visible ref and ` +
      `bypasses workspace coordination — the workspace tip, overlap warnings, and activity would go ` +
      `stale. Publish it with \`deepspace workspace sync\` instead.`,
  }
}

export default defineDeepspaceCommand({
  meta: {
    name: 'push',
    description: `Push local git commits to the app's cloud repo (${PUSH_CEILINGS})`,
  },
  args: {
    branch: {
      type: 'string',
      alias: 'b',
      description: 'Branch to push (default: the current branch)',
      required: false,
    },
    app: {
      type: 'string',
      alias: 'a',
      description:
        'App id or subdomain name (default: DEEPSPACE_APP_ID from the nearest wrangler.toml)',
      required: false,
    },
    force: {
      type: 'boolean',
      description:
        'Allow a non-fast-forward ref move to rewrite history you previously pushed with `deepspace push`. Guarded: refuses whenever the remote tip is a commit your branch does not contain, so no work is silently dropped (a first force from a fresh clone/pull is refused until you re-integrate that tip).',
      default: false,
    },
  },
  async run({ args }) {
    const branchArg = args.branch === undefined ? undefined : String(args.branch)
    const appArg = typeof args.app === 'string' ? args.app : undefined
    const force = args.force === true
    // Outside the try: the catch below needs it to name oversized objects.
    const appDir = findAppDir()
    try {
      if (!appDir)
        throw new Refusal(
          'No wrangler.toml found — run from inside an app directory.',
          'not_in_app_repo',
        )

      assertSyncableRepo(appDir)
      // An explicitly-blank --branch must not silently fall back to the current
      // branch (an unset `--branch "$VAR"` would push the wrong ref).
      if (branchArg !== undefined) {
        const b = branchArg.trim()
        if (!b) throw new Refusal('--branch was given an empty branch name.', 'invalid_branch')
        if (!isPlausibleBranchName(b))
          throw new Refusal(`--branch "${b}" is not a valid git branch name.`, 'invalid_branch')
      }
      const branch = branchArg?.trim() || currentBranch(appDir)
      if (!branch) {
        throw new Refusal(
          'HEAD is detached — pass --branch <name> to choose what to push.',
          'detached_head',
        )
      }
      const tipOid = resolveCommit(appDir, `refs/heads/${branch}`)
      if (!tipOid) {
        // refs/heads/<branch> doesn't resolve. If the repo HAS commits (HEAD
        // resolves), the branch simply doesn't exist — a typo'd -b, not an empty
        // repo. "commit first" is wrong advice there (committing on the current
        // branch never makes the missing ref appear — an agent would loop), so
        // give it a distinct code + remedy. Reserve no_commits for a genuinely
        // unborn repo (no HEAD at all).
        if (resolveCommit(appDir, 'HEAD')) {
          throw new Refusal(
            `Branch "${branch}" does not exist — create or switch to it first (e.g. git switch -c ${shQuote(branch)}), then push.`,
            'unknown_branch',
          )
        }
        throw new Refusal(
          `Branch "${branch}" has no commits yet — commit first, then push.`,
          'no_commits',
        )
      }

      const spinner = args.json ? null : createSpinner()
      spinner?.start(`Checking ${branch} before push…`)
      const resolveTarget = async (): Promise<{ token: string; appId: string }> => {
        // Blank --app / missing app context is a client-side error — reject it
        // BEFORE the token read so it never surfaces as not_authenticated.
        assertAppTargetResolvable(appArg)
        const token = await ensureToken()
        // Accepts an id OR a subdomain name — a raw name must never pass
        // through as a literal app id (it would register a phantom app).
        const appId = await resolveAppTarget(deployBaseUrl(), token, appArg)
        await warnIfPhantomApp(deployBaseUrl(), token, appId, appArg?.trim() || undefined)
        return { token, appId }
      }

      // A workspace branch must go through `workspace sync`, not a plain push.
      // Resolve the target before emitting the continuation so a name or local
      // default cannot drift to another app when an agent executes it later.
      const wsRefusal = workspaceBranchPushRefusal(branch)
      if (wsRefusal) {
        const { appId } = await resolveTarget()
        const checkoutPath = selectedBranchCheckout(appDir, branch)
        const workspaceId = workspaceIdFromBranch(branch)
        if (!workspaceId) throw new Error(`Workspace branch did not contain an id: ${branch}`)
        const syncCommand =
          `deepspace workspace sync --app ${shQuote(appId)} ` +
          `--workspace ${shQuote(workspaceId)}`
        const quotedSyncCommand = `\`${syncCommand}\``
        const message = checkoutPath
          ? `${wsRefusal.error} Run ${quotedSyncCommand} from its checkout at ${checkoutPath}.`
          : `${wsRefusal.error} ${branch} exists locally but is not checked out. Check it out in a clean worktree, then run ${quotedSyncCommand}.`
        const action: CliAction | undefined = checkoutPath
          ? {
              cwd: checkoutPath,
              argv: ['deepspace', 'workspace', 'sync', '--app', appId, '--workspace', workspaceId],
            }
          : undefined
        spinner?.stop('Workspace branch.')
        throw new Refusal(message, wsRefusal.code, {
          actionRequired: action !== undefined,
          action,
          extra: { appId, branch, ...(checkoutPath ? { worktreePath: checkoutPath } : {}) },
        })
      }

      // Push IS `git push`, so it sends whatever was committed — including a
      // force-committed `.dev.vars` that .gitignore would normally keep out.
      // The push wrapper refuses them early; the server independently enforces
      // the same case-insensitive basename contract for raw Git clients.
      const secretFiles = trackedSecretFiles(appDir, tipOid)
      if (secretFiles.length > 0) {
        const checkoutPath = selectedBranchCheckout(appDir, branch)
        const checkoutNote = checkoutPath
          ? ''
          : ` Check out ${shQuote(branch)} in a clean worktree before untracking it.`
        throw new Refusal(
          `Refusing to push: the branch tracks secret file(s) — ${secretFiles.join(', ')}. ` +
            `These hold local secrets and must not reach the cloud repo. Untrack with ` +
            `\`git rm --cached ${shQuote(secretFiles[0])}\`, ensure it's .gitignored, commit, then push.` +
            checkoutNote,
          SECRET_IN_HISTORY_CODE,
          {
            action: checkoutPath
              ? { cwd: checkoutPath, argv: ['git', 'rm', '--cached', secretFiles[0]] }
              : undefined,
            extra: { branch, ...(checkoutPath ? { worktreePath: checkoutPath } : {}) },
          },
        )
      }

      const { token, appId } = await resolveTarget()
      // Refuse an unregistered or foreign id before git runs: the repo
      // transport errors that would otherwise surface discard the server's
      // JSON body and read as missing repositories or internal URLs instead
      // of the registration/ownership gap they are.
      let sourceState
      try {
        sourceState = await getAppSource(deployBaseUrl(), token, appId)
      } catch (error) {
        if (error instanceof ApiError && error.code === 'forbidden') {
          throw new Refusal(
            `${appId} is registered to another user. Run \`deepspace app init --new-id\` to ` +
              'fork this repo as your own app (new data and secrets; the original is untouched).',
            'not_app_owner',
          )
        }
        throw error
      }
      if (!sourceState.registered) {
        throw new Refusal(
          `${appId} is not registered. If this repo's id came from an older SDK's scaffold, ` +
            'run `deepspace app init --new-id` to register it as a fresh app; a brand-new ' +
            'app dir registers with `deepspace app init`.',
          'app_not_registered',
        )
      }
      const pullRecoveryCwd = selectedBranchCheckout(appDir, branch) ?? appDir
      ensureSpaceRemote(appDir, appId)

      // A `--force` push moves the ref non-fast-forward. That's legitimate for
      // rewriting YOUR OWN line (amend/rebase), but it must NOT silently drop a
      // peer's commits that landed on the cloud branch since you last synced —
      // the orphan protection this file's header describes for `deepspace push
      // --force` (a plain `git push --force` is out of our reach — see header).
      // Two ingredients:
      //   1. lastPushed = an environment-private ref that only
      //      our own successful push writes (see below). The obvious candidate,
      //      the remote-tracking ref is force-advanced by `deepspace pull`,
      //      deploy, workspace fetches, and a bare `git fetch space` — so using it
      //      would let the pull-then-retry flow the refusal itself recommends
      //      poison the baseline and wave a clobber through. The workspace path is
      //      safe for exactly this reason: its hidden ref moves only on its own
      //      successful push.
      //   2. the current remote tip, fetched into FETCH_HEAD with `--refmap=` so
      //      this guard's own fetch can't advance the tracking ref either.
      // Refuse if force-pushing would orphan the peer's work.
      if (force) {
        spinner?.message(`Checking the cloud ${branch} tip before force-push…`)
        const lastPushed = resolveCommit(appDir, spacePrivateRef(`pushed/${branch}`))
        let remoteTip: string | null = null
        try {
          runGitRemote(appDir, token, [
            'fetch',
            '--quiet',
            '--refmap=',
            SPACE_REMOTE,
            `refs/heads/${branch}`,
          ])
          remoteTip = resolveCommit(appDir, 'FETCH_HEAD')
        } catch {
          // The fetch failed. We must NOT fall through to a blind force — that
          // would silently orphan a peer who'd advanced the branch. Disambiguate
          // with ls-remote: an absent branch (exit 0, empty) is a first-touch
          // force (nothing to orphan, safe); anything else (a non-zero status, or
          // an advertised tip we couldn't fetch) means we can't verify the tip, so
          // refuse — fail CLOSED.
          const ls = runGitRemote(
            appDir,
            token,
            ['ls-remote', SPACE_REMOTE, `refs/heads/${branch}`],
            {
              allowFail: true,
            },
          )
          if (ls.status === 0 && ls.stdout.toString('utf-8').trim() === '') {
            remoteTip = null // no such remote branch yet — first push, safe to force
          } else {
            const error =
              `Couldn't reach the cloud repo to check ${branch} before force-pushing. ` +
              `Refusing --force so it can't silently drop a peer's commits — retry when connected, ` +
              `or run \`deepspace pull --app ${shQuote(appId)} --branch ${shQuote(branch)}\` ` +
              `to integrate first.`
            // No `Next:`/`next`: the fix is "retry when connected" (not a single
            // command), and `deepspace pull` needs the very connectivity that just
            // failed — so naming it would loop an agent.
            // Plain failure (exit 1): NOTHING worked and no local step
            // remains — actionRequired/exit-2 is reserved for "the operation
            // succeeded, now it's your turn", which this is not.
            throw new Refusal(error, 'force_unverified', { extra: { appId, branch } })
          }
        }
        if (
          remoteTip &&
          forcePushOrphansWork(lastPushed, remoteTip, tipOid, isAncestor(appDir, remoteTip, tipOid))
        ) {
          const error =
            `The cloud repo's ${branch} advanced since you last synced — a peer pushed commit(s) you don't have. ` +
            `Force-pushing now would DROP that work. Run ` +
            `\`deepspace pull --app ${shQuote(appId)} --branch ${shQuote(branch)}\` and merge ` +
            `(or rebase onto it), then push.`
          throw new Refusal(error, 'diverged', {
            actionRequired: true,
            action: pullRecoveryAction(pullRecoveryCwd, appId, branch),
            extra: { appId, branch },
          })
        }
      }

      spinner?.message(`Pushing ${branch} to the cloud repo…`)
      const result = pushToSpace(appDir, token, `refs/heads/${branch}:refs/heads/${branch}`, {
        force,
      })
      spinner?.stop(
        result.status === 'up_to_date'
          ? `${branch} is already up to date at ${tipOid.slice(0, 10)}.`
          : result.status === 'committed'
            ? `Pushed ${branch} → ${tipOid.slice(0, 10)}.`
            : `Push did not complete.`,
      )

      const ok = result.status === 'up_to_date' || result.status === 'committed'
      if (ok) {
        // Record what THIS client just published, in a PRIVATE ref that only our
        // own successful push writes — the "last pushed by me" baseline the
        // --force orphan guard above reads. A bare `git fetch` / `deepspace pull`
        // never advances it (unlike the remote-tracking ref), so the guard
        // can't be poisoned into misreading a peer's tip as our own line.
        updateRef(appDir, spacePrivateRef(`pushed/${branch}`), tipOid)
      }
      // A moved/diverged ref is a recovery state, not a dead end: nothing was
      // pushed, and `deepspace pull` is the one re-entry command. Carry that as
      // structured fields so an agent doesn't have to scrape the prose (a
      // server-side `rejected` — oversize, policy — is NOT self-recoverable).
      const recoverable = isRecoverablePushFailure(result.status)
      const rejectReason = result.reason ?? result.summary
      const errorMsg = ok
        ? null
        : result.status === 'ref_conflict'
          ? `The cloud repo's ${branch} moved while you worked (${rejectReason}). ` +
            `Run \`deepspace pull --app ${shQuote(appId)} --branch ${shQuote(branch)}\` ` +
            `to integrate, then push again.`
          : result.status === 'rejected'
            ? pushFailureMessage(`The cloud repo rejected ${branch}`, result, appDir ?? undefined)
            : `The cloud repo's ${branch} has commit(s) your local ${branch} doesn't. ` +
              `Run \`deepspace pull --app ${shQuote(appId)} --branch ${shQuote(branch)}\` ` +
              `and merge (or rebase), then push. Avoid --force here — it's guarded and ` +
              `will refuse rather than silently drop a peer's commits.`

      // Completeness: `appId` is the one --json fact the spinner line doesn't
      // already carry (branch + oid are in it), so the human surface names it too.
      if (!args.json && ok) p.log.info(`App: ${appId}`)
      // A push that landed is terminal — whether to deploy or open a workspace is
      // the agent's call, and a `Next:` there would be filler. Only the recoverable
      // divergence has one true follow-up.
      const action = recoverable ? pullRecoveryAction(pullRecoveryCwd, appId, branch) : undefined
      // A recoverable divergence (non_fast_forward / ref_conflict) is the
      // action-required tier — it already carries `actionRequired:true` + a
      // `action` above, so exit 2 like `push --force` diverged / `pull` diverged /
      // `workspace land` dirty. A non-recoverable rejection (oversize, policy)
      // stays an ordinary exit 1.
      if (!ok) {
        throw new Refusal(errorMsg ?? `Push did not complete.`, result.status, {
          actionRequired: recoverable,
          action,
          extra: { status: result.status, appId, branch, oid: tipOid },
        })
      }
      return { data: { status: result.status, appId, branch, oid: tipOid } }
    } catch (err) {
      if (err instanceof Refusal) throw err
      const transportFailure = classifyPushTransportFailure(err, appDir ?? undefined)
      if (transportFailure) {
        throw new Refusal(transportFailure.error, transportFailure.code)
      }
      throw err
    }
  },
})
