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
import { getAppSource, githubSourceRefusal } from '../lib/source-api'
import { findAppDir } from '../lib/app-context'
import { readAppId } from '../lib/app-identity'
import { hasWranglerConfig, noWranglerConfigMessage } from '../lib/wrangler-env'
import { resolveAppTarget, warnIfPhantomApp, assertAppTargetResolvable } from '../lib/app-target'
import {
  assertNoOperationInProgress,
  assertSyncableRepo,
  currentBranch,
  isAncestor,
  isPlausibleBranchName,
  listWorktrees,
  resolveCommit,
  updateRef,
} from '../lib/git/repository'
import {
  SECRET_IN_HISTORY_CODE,
  secretFilesInPushRange,
  secretRecoverySentence,
} from '../lib/git/safety'
import { workspaceIdFromBranch } from '../lib/workspace-id'
import { shQuote } from '../lib/cli-format'
import {
  classifyPushTransportFailure,
  classifyRejection,
  isRecoverablePushFailure,
  parseRefusalCode,
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

/**
 * The cloud tip for `branch`, read through a `--refmap=` fetch that cannot
 * advance any tracking ref (so this probe can never poison the `--force`
 * guard's baseline). Null when unverifiable — every caller fails toward the
 * generic pull advice rather than a wrong specific one.
 */
function fetchRemoteTip(appDir: string, token: string, branch: string): string | null {
  try {
    runGitRemote(appDir, token, [
      'fetch',
      '--quiet',
      '--refmap=',
      SPACE_REMOTE,
      `refs/heads/${branch}`,
    ])
    return resolveCommit(appDir, 'FETCH_HEAD')
  } catch {
    return null
  }
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
  // The whole `ws/` prefix, not only well-formed ids: `ws/fakeid` passes no
  // ULID check yet becomes a real branch that `land --into` then accepts as a
  // landing target, stranding the work on it.
  // Case-SENSITIVE, matching the server and git itself — with `/i` the CLI
  // would be STRICTER than the server, refusing `WS/foo` (a legal branch the
  // server accepts, and one `git push space WS/foo` publishes) and telling the
  // agent to rename it.
  if (!id && !branch?.startsWith('ws/')) return null
  return {
    code: 'workspace_branch',
    error:
      `"${branch}" is in the workspace branch namespace${id ? ` (${id})` : ''}. A plain push moves only the visible ref and ` +
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
        "Allow a non-fast-forward ref move to rewrite history you previously pushed with `deepspace push`. Guarded by a per-checkout push record: allowed when THIS checkout published the cloud tip with `deepspace push` (your own amend/rebase), refused when the cloud tip is any other commit your branch does not contain — so a peer's work is never silently dropped. A plain `git push space` leaves no record, so a force over a tip published that way is refused until you re-integrate it, as is a first force from a fresh clone/pull.",
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
      if (!appDir) throw new Refusal(noWranglerConfigMessage(process.cwd()), 'not_in_app_repo')

      assertSyncableRepo(appDir)
      assertNoOperationInProgress(appDir)
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
        // This fires BEFORE the identity preflight (which needs a token and
        // three server round-trips — too expensive to hoist above the local
        // checks, and hoisting it would change which refusal every other
        // local failure gets). An unborn HEAD on a scaffold that still carries
        // the `__APP_ID__` placeholder is exactly the logged-out state
        // `app init` heals, so that case names it (and ships it as the action):
        // obeying "commit first" literally would freeze the placeholder into
        // the repo's first commit. With a real id already in wrangler.toml,
        // "commit first" is simply right.
        const uninitialized = hasWranglerConfig(appDir) && readAppId(appDir) === null
        throw new Refusal(
          uninitialized
            ? `Branch "${branch}" has no commits yet, and wrangler.toml still holds the \`__APP_ID__\` ` +
                'placeholder — run `deepspace app init` first: it registers the app and makes the ' +
                'initial commit (committing first would put the unregistered placeholder in history).'
            : `Branch "${branch}" has no commits yet — commit first, then push.`,
          'no_commits',
          // Same remedy as deploy's `app_not_initialized`, so it gets the same
          // tier: an executable `app init` is the action-required contract
          // (`actionRequired: true`, exit 2). Without the flag an agent that
          // branches on the documented signal silently dropped this case while
          // handling deploy's identical one. "Commit first" ships no action and
          // stays an ordinary exit 1 — there is no one command to run.
          uninitialized
            ? {
                action: { cwd: appDir, argv: ['deepspace', 'app', 'init'] },
                actionRequired: true,
              }
            : {},
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
        if (!workspaceId) {
          // The predicate above covers the whole `ws/` prefix, so a malformed
          // id reaches here. It has no workspace to sync, so its recovery is a
          // different one: get out of the namespace.
          spinner?.stop('Workspace branch.')
          throw new Refusal(
            `${wsRefusal.error} "${branch}" carries no workspace id, so nothing can publish it — rename it out of the \`ws/\` namespace (\`git branch -m ${shQuote(branch)} <name>\`) and push that.`,
            wsRefusal.code,
            { extra: { appId, branch } },
          )
        }
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
      //
      // Scanned over the whole RANGE being sent, which is what the server
      // scans: a secret added in one commit and removed in a later one still
      // rides the pack. The base is what the cloud already holds for this
      // branch — its tracking ref, else this checkout's own push record —
      // and null (scan the whole tip tree) when nothing here knows.
      const secretFiles = secretFilesInPushRange(
        appDir,
        resolveCommit(appDir, `refs/remotes/${SPACE_REMOTE}/${branch}`) ??
          resolveCommit(appDir, spacePrivateRef(`pushed/${branch}`)),
        tipOid,
      )
      if (secretFiles.length > 0) {
        const checkoutPath = selectedBranchCheckout(appDir, branch)
        const checkoutNote = checkoutPath
          ? ''
          : ` Check out ${shQuote(branch)} in a clean worktree to do it.`
        // NO action, deliberately: `git rm --cached <file>` does not resolve a
        // refusal about the RANGE, so an agent following the "run the action,
        // then retry" contract re-runs it against a byte-identical refusal.
        // Rewriting history needs judgment about which commits are safe to
        // rewrite — a refusal without an action, per the CLI contract.
        throw new Refusal(
          `Refusing to push: the commits being sent carry secret file(s) — ${secretFiles.join(', ')}. ` +
            `These hold local secrets and must not reach the cloud repo. ` +
            secretRecoverySentence(secretFiles, 'push') +
            checkoutNote,
          SECRET_IN_HISTORY_CODE,
          {
            extra: {
              branch,
              files: secretFiles,
              ...(checkoutPath ? { worktreePath: checkoutPath } : {}),
            },
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
      // GitHub-source apps have no cloud repo to push to. Refuse HERE, where
      // the repository name is in hand: the server's own 422 says the same
      // thing but git's smart-HTTP transport discards its body, so the CLI
      // could only ever reconstruct a repository-less sentence from the bare
      // status. This is the best-informed site, and it refuses before git runs.
      if (sourceState.source?.provider === 'github') {
        throw githubSourceRefusal(appId, sourceState.source.repository)
      }
      const pullRecoveryCwd = selectedBranchCheckout(appDir, branch) ?? appDir
      // The token goes in: every recovery this command hands back (`deepspace
      // pull`, then a merge) writes a commit, and a fresh clone with no global
      // git identity dies on `unable to auto-detect email address` where we
      // told the user to run it. `ensureSpaceRemote` is the identity seam.
      ensureSpaceRemote(appDir, appId, undefined, token)

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
          // Strictly BEHIND is its own state, not a divergence: the cloud tip
          // CONTAINS this checkout's tip, so the force would publish nothing
          // and only REWIND the branch. The commits it drops are provable
          // here, not a hedge about a possible peer.
          if (isAncestor(appDir, tipOid, remoteTip)) {
            throw new Refusal(
              `The cloud repo's ${branch} is at ${remoteTip.slice(0, 10)} and already contains ` +
                `everything this checkout has — this checkout is strictly behind. Force-pushing ` +
                `would REWIND the branch and drop the newer commit(s). Run ` +
                `\`deepspace pull --app ${shQuote(appId)} --branch ${shQuote(branch)}\` to ` +
                `fast-forward, then push normally if anything is left to publish.`,
              'behind',
              {
                actionRequired: true,
                action: pullRecoveryAction(pullRecoveryCwd, appId, branch),
                extra: { appId, branch },
              },
            )
          }
          // The guard proves ownership from THIS checkout's own push record, so
          // absent that record it cannot tell "a peer pushed" from "this
          // checkout published the tip some other way" — a plain `git push
          // space` writes no record. State the fact that holds rather than
          // asserting a peer.
          const error =
            `The cloud repo's ${branch} is at ${remoteTip.slice(0, 10)}, and this checkout has no ` +
            `record of publishing it (\`deepspace push\` records its own pushes; a plain ` +
            `\`git push ${SPACE_REMOTE}\` does not), so a peer's work on top can't be ruled out. ` +
            `Force-pushing now would DROP that line. Run ` +
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
      const ok = result.status === 'up_to_date' || result.status === 'committed'
      if (result.status === 'committed') {
        // Record what THIS client just PUBLISHED, in a PRIVATE ref that only our
        // own successful push writes — the "last pushed by me" baseline the
        // --force orphan guard above reads. A bare `git fetch` / `deepspace pull`
        // never advances it (unlike the remote-tracking ref), so the guard
        // can't be poisoned into misreading a peer's tip as our own line.
        //
        // `up_to_date` is deliberately EXCLUDED: it says the cloud tip already
        // equals ours, which is just as true right after pulling a PEER's
        // commit. Recording it there claims ownership of work this checkout
        // never published, and a later `--force` — waved through as "your own
        // line" — then drops the peer's commit.
        updateRef(appDir, spacePrivateRef(`pushed/${branch}`), tipOid)
      }
      // A moved/diverged ref is a recovery state, not a dead end: nothing was
      // pushed, and `deepspace pull` is the one re-entry command. Carry that as
      // structured fields so an agent doesn't have to scrape the prose (a
      // server-side `rejected` — oversize, policy — is NOT self-recoverable).
      const recoverable = isRecoverablePushFailure(result.status)
      const rejectReason = result.reason ?? result.summary
      // One probe answers both questions a rejected fast-forward raises. The
      // probe FETCHES, so the spinner stays up across it and is stopped below:
      // stopping on the push result first leaves a silent network wait after
      // the last thing the user saw.
      const rejectedFastForward = !ok && result.status === 'non_fast_forward' && !force
      if (rejectedFastForward) spinner?.message(`Checking the cloud ${branch} tip…`)
      const remoteTip = rejectedFastForward ? fetchRemoteTip(appDir, token, branch) : null
      // A non-fast-forward onto a tip THIS checkout published is an amend or
      // rebase of your own line — the one force the guard blesses. The blanket
      // pull advice makes git resurrect the commit you just amended away, as a
      // conflict against yourself.
      const ownRewrite =
        remoteTip !== null &&
        remoteTip === resolveCommit(appDir, spacePrivateRef(`pushed/${branch}`))
      // Strictly BEHIND is its own state, and the same classification the
      // `--force` guard makes: the cloud tip CONTAINS ours, so there is nothing
      // local to publish and a pull fast-forwards. `non_fast_forward` there
      // tells an agent to reconcile a divergence that does not exist.
      const strictlyBehind =
        remoteTip !== null && !ownRewrite && isAncestor(appDir, tipOid, remoteTip)
      spinner?.stop(
        result.status === 'up_to_date'
          ? `${branch} is already up to date at ${tipOid.slice(0, 10)}.`
          : result.status === 'committed'
            ? `Pushed ${branch} → ${tipOid.slice(0, 10)}.`
            : `Push did not complete.`,
      )
      const pullNext =
        `Run \`deepspace pull --app ${shQuote(appId)} --branch ${shQuote(branch)}\` ` +
        `and merge (or rebase onto it), then push.`
      const errorMsg = ok
        ? null
        : result.status === 'ref_conflict'
          ? // The machine token belongs in `code`, not mid-sentence: the reason
            // arrives as `<code>: <sentence>`, and printing it raw put
            // "stale_ref: stale ref, fetch first" inside human prose.
            `The cloud repo's ${branch} moved while you worked (${parseRefusalCode(rejectReason)?.sentence ?? rejectReason}). ` +
            `Run \`deepspace pull --app ${shQuote(appId)} --branch ${shQuote(branch)}\` ` +
            `to integrate, then push again.`
          : result.status === 'rejected'
            ? pushFailureMessage(`The push of ${branch}`, result, appDir ?? undefined)
            : ownRewrite
              ? `The cloud repo's ${branch} is exactly the tip THIS checkout last pushed, and ` +
                `your local ${branch} no longer contains it — you rewrote your own published ` +
                `line (amend/rebase). Publish the rewrite with ` +
                `\`deepspace push --force --branch ${shQuote(branch)}\`: the guard allows it ` +
                `because it discards only your own superseded tip. (Pulling instead would ` +
                `merge the commit you just amended away back in.)`
              : strictlyBehind
                ? `The cloud repo's ${branch} is at ${remoteTip!.slice(0, 10)} and already ` +
                  `contains everything this checkout has — this checkout is just behind, with ` +
                  `nothing of its own to publish. Run ` +
                  `\`deepspace pull --app ${shQuote(appId)} --branch ${shQuote(branch)}\` to ` +
                  `fast-forward, then push again if anything is left.`
                : `The cloud repo's ${branch} has commit(s) your local ${branch} doesn't. ` +
                  `${pullNext} Avoid --force here — it's guarded and ` +
                  `will refuse rather than silently drop a peer's commits.`

      // Completeness: `appId` is the one --json fact the spinner line doesn't
      // already carry (branch + oid are in it), so the human surface names it too.
      if (!args.json && ok) p.log.info(`App: ${appId}`)
      // A push that landed is terminal — whether to deploy or open a workspace is
      // the agent's call, and a `Next:` there would be filler. Only the recoverable
      // divergence has one true follow-up.
      const action: CliAction | undefined = ownRewrite
        ? {
            cwd: pullRecoveryCwd,
            argv: ['deepspace', 'push', '--force', '--app', appId, '--branch', branch],
          }
        : recoverable
          ? pullRecoveryAction(pullRecoveryCwd, appId, branch)
          : undefined
      // A recoverable divergence (non_fast_forward / ref_conflict) is the
      // action-required tier — it already carries `actionRequired:true` + a
      // `action` above, so exit 2 like `push --force` diverged / `pull` diverged /
      // `workspace land` dirty. A non-recoverable rejection (oversize, policy)
      // stays an ordinary exit 1.
      if (!ok) {
        // `rejected` is the server's catch-all; `classifyRejection` is the one
        // place its reason text becomes a code, and `pushFailureMessage` (the
        // sentence above) reads the same call — so the slug an agent branches
        // on and the prose a human reads cannot describe different failures.
        const code =
          result.status === 'rejected'
            ? classifyRejection(rejectReason, appDir ?? undefined).code
            : strictlyBehind
              ? 'behind'
              : result.status
        throw new Refusal(errorMsg ?? `Push did not complete.`, code, {
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
        // Keep git's own text alongside our prose. The HTTP status is the ONLY
        // diagnostic that survives a smart-HTTP failure (the response body is
        // dropped), so it is the one thing that says which failure this was.
        throw new Refusal(transportFailure.error, transportFailure.code, {
          extra: { gitError: err instanceof Error ? err.message : String(err) },
        })
      }
      throw err
    }
  },
})
