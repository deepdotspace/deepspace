import * as p from '@clack/prompts'
import { errorCode } from '../../lib/cli-errors'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import { executableAction, type CliAction } from '../../lib/output'
import { runGit } from '../../lib/git/process'
import {
  isAncestor,
  isPlausibleBranchName,
  isWorkTreeClean,
  listWorktrees,
  resolveCommit,
} from '../../lib/git/repository'
import { committedSecretRefusal } from '../../lib/git/safety'
import {
  classifyRejection,
  parseRefusalCode,
  pushFailureMessage,
  pushToSpace,
} from '../../lib/vc-push'
import {
  ensureSpaceRemote,
  runGitRemote,
  SPACE_REMOTE,
  spaceTrackingRef,
} from '../../lib/vc-remote'
import { resolveValidationCommand, runValidationCommand } from '../../lib/validation'
import { createSpinner } from '../../lib/spinner'
import { humanCommand } from '../../lib/cli-format'
import {
  cleanupAction,
  cleanupJson,
  cleanupRefusalMessage,
  cleanupWorkspaceLocal,
  inOwnLinkedWorktree,
  reportCleanupHuman,
} from './local'
import {
  APP_ARG,
  assertExplicitWorkspaceId,
  assertSelectedWorkspaceCheckout,
  inferWorkspaceId,
  pushWorkspaceRef,
  resolveTarget,
  workspaceNotActiveRefusal,
} from './runtime'

export function hasLeftoverConflictMarkers(diffCheckOutput: string): boolean {
  return /leftover conflict marker/.test(diffCheckOutput)
}

/** The files `git diff --check` flagged, so the refusal can name them. */
export function conflictMarkerFiles(diffCheckOutput: string): string[] {
  const files = new Set<string>()
  for (const line of diffCheckOutput.split('\n')) {
    const match = /^(.+?):\d+: leftover conflict marker/.exec(line)
    if (match) files.add(match[1])
  }
  return [...files]
}

/**
 * The runnable twin of the "catch up" line — the interpreter/entry is pinned
 * HERE (executableAction), because the caller builds it before cleanup, which
 * can delete the npx-installed entry this process is running from; resolving
 * at print time in the shared output runtime is too late.
 */
export function staleTrunkPullAction(
  trunkCheckoutDir: string,
  intoBranch: string,
  appArg?: string,
): CliAction {
  return executableAction({
    cwd: trunkCheckoutDir,
    argv: [
      'deepspace',
      'pull',
      '-b',
      intoBranch,
      // The trunk checkout is a DIFFERENT directory; carry `-a` when the
      // caller named an app, or the action could resolve a different one
      // from that cwd.
      ...(appArg && appArg.trim() ? ['-a', appArg.trim()] : []),
    ],
  })
}

/**
 * The checkout holding `intoBranch` when a land just moved that branch past
 * it, or null — the one fact behind land's "catch up" line and its `deepspace
 * pull` action.
 *
 * Names the worktree actually ON the branch, not the primary checkout:
 * `deepspace pull` refuses inside a workspace worktree (it is on a `ws/*`
 * branch), so pointing there would prescribe a command that cannot run.
 *
 * Strictly BEHIND only — pull fast-forwards, so an AHEAD or DIVERGED local
 * trunk is a different conversation and gets no action rather than one that
 * would be refused.
 */
export function staleTrunkCheckout(
  appDir: string,
  intoBranch: string,
  landedOid: string,
): string | null {
  // `listWorktrees` already drops entries whose directory is gone, so `dir` is
  // a cwd git calls can run in.
  const dir = listWorktrees(appDir).find((worktree) => worktree.branch === intoBranch)?.path ?? null
  if (dir === null) return null
  const localTip = resolveCommit(dir, `refs/heads/${intoBranch}`)
  if (localTip === null || localTip === landedOid) return null
  return isAncestor(dir, localTip, landedOid) ? dir : null
}

export interface LandArgs {
  workspace?: string
  into?: string
  validate?: boolean
  'keep-worktree'?: boolean
}

/** Rebuild land argv so every resumable refusal preserves the caller's safety flags. */
export function landResumeArgv(args: LandArgs): string[] {
  const argv = ['deepspace', 'workspace', 'land']
  const workspace = args.workspace?.trim()
  if (workspace) argv.push('-w', workspace)
  const into = args.into?.trim()
  if (into) argv.push('--into', into)
  if (args.validate) argv.push('--validate')
  if (args['keep-worktree']) argv.push('--keep-worktree')
  return argv
}

export const landWorkspaceCommand = defineDeepspaceCommand({
  meta: { name: 'land', description: 'Merge this workspace into trunk (both sides retained)' },
  args: {
    into: {
      type: 'string',
      description: 'Target branch (default: the cloud repo default branch)',
      required: false,
    },
    workspace: {
      type: 'string',
      alias: 'w',
      description: 'Workspace id (default: inferred from the ws/<id> branch)',
      required: false,
    },
    'keep-worktree': {
      type: 'boolean',
      description: 'Keep the local worktree and branch after landing',
      default: false,
    },
    validate: {
      type: 'boolean',
      description:
        'Run the project validation on the merged tree before publishing trunk (exit 2 on failure)',
      default: false,
    },
    app: APP_ARG,
  },
  async run({ args }) {
    const intoArg = typeof args.into === 'string' ? args.into : undefined
    const workspaceArg = typeof args.workspace === 'string' ? args.workspace : undefined
    const validate = Boolean(args.validate)
    const keepWorktree = Boolean(args['keep-worktree'])
    if (args.into !== undefined) {
      const branch = String(args.into).trim()
      if (!branch) {
        throw new Refusal('--into was given an empty branch name.', 'invalid_branch')
      }
      if (!isPlausibleBranchName(branch)) {
        throw new Refusal(`--into "${branch}" is not a valid git branch name.`, 'invalid_branch')
      }
    }
    assertExplicitWorkspaceId(workspaceArg)
    const spinner = args.json ? null : createSpinner()
    spinner?.start('Preparing workspace land…')
    const { appDir, appId, token, api } = await resolveTarget(
      typeof args.app === 'string' ? args.app : undefined,
    )
    const id = inferWorkspaceId(appDir, workspaceArg)
    const resumeArgv = landResumeArgv({
      workspace: workspaceArg,
      into: intoArg,
      validate,
      'keep-worktree': keepWorktree,
    })
    const recoveryAction: CliAction = { cwd: appDir, argv: resumeArgv }
    const resumeNext = humanCommand(resumeArgv)
    const dropAction: CliAction = {
      cwd: appDir,
      argv: ['deepspace', 'workspace', 'drop', id, '--app', appId],
    }
    // A FINISHED workspace outranks a checkout mismatch: sending someone to
    // attach a landed workspace prescribes a command that cannot succeed.
    // Guarded read — the mismatch is a purely LOCAL determination, and a
    // network blip must surface it, not replace it with a lookup error.
    try {
      assertSelectedWorkspaceCheckout(appDir, id, resumeArgv)
    } catch (mismatch) {
      const current = await api
        .getWorkspace(id)
        .then((r) => r.view)
        .catch(() => null)
      if (current && current.workspace.status !== 'active') {
        spinner?.stop('Workspace finished.')
        throw workspaceNotActiveRefusal(id, current.workspace.status, dropAction)
      }
      throw mismatch
    }
    const headBefore = resolveCommit(appDir, 'HEAD')
    if (!headBefore) {
      throw new Refusal('The workspace has no commits — nothing to land.', 'no_commits')
    }

    if (!isWorkTreeClean(appDir)) {
      throw new Refusal(
        `The worktree has uncommitted changes, and landing publishes committed HEAD only. Commit them to this workspace branch, then re-run \`${resumeNext}\`.`,
        'dirty_worktree',
        { extra: { workspaceId: id } },
      )
    }

    spinner?.message(`Landing ${id}…`)
    const [{ view }, refs] = await Promise.all([api.getWorkspace(id), api.getRefs()])
    if (view.workspace.status !== 'active') {
      spinner?.stop('Workspace finished.')
      throw workspaceNotActiveRefusal(id, view.workspace.status, dropAction)
    }
    ensureSpaceRemote(appDir, appId, undefined, token)

    // A conflict retry keeps the pure workspace line immutable: HEAD's first parent is its tip.
    const isResumedMerge =
      resolveCommit(appDir, 'HEAD^2') !== null &&
      view.tipOid !== null &&
      resolveCommit(appDir, 'HEAD^') === view.tipOid
    if (!isResumedMerge) {
      // `view.tipOid` is what the cloud already holds for this workspace ref:
      // it bounds the secret scan to the commits this publish actually
      // uploads, and it is what lets the refusal tell "strictly behind" from a
      // real divergence. Without it the scan degrades to the tip tree alone.
      pushWorkspaceRef(appDir, token, view.workspace.ref, headBefore, view.tipOid)
    }

    const intoBranch =
      intoArg?.trim() ||
      (refs?.head?.startsWith('refs/heads/') ? refs.head.slice('refs/heads/'.length) : null)
    if (!intoBranch) {
      spinner?.stop('No trunk.')
      throw new Refusal(
        'The cloud repo has no default branch yet — push trunk first (`deepspace push`), then land.',
        'no_default_branch',
      )
    }
    const intoRef = `refs/heads/${intoBranch}`
    const remoteRef = spaceTrackingRef(intoBranch)
    runGitRemote(appDir, token, ['fetch', '--quiet', SPACE_REMOTE, `+${intoRef}:${remoteRef}`], {
      allowFail: true,
    })
    const remoteTip = resolveCommit(appDir, remoteRef)

    if (
      remoteTip &&
      runGit(appDir, ['merge-base', '--is-ancestor', remoteTip, 'HEAD'], { allowFail: true })
        .status !== 0
    ) {
      const hasIdent = runGit(appDir, ['config', 'user.email'], { allowFail: true }).status === 0
      const identEnv: Record<string, string> = hasIdent
        ? {}
        : {
            GIT_AUTHOR_NAME: 'DeepSpace Workspace',
            GIT_AUTHOR_EMAIL: 'workspace@deep.space',
            GIT_COMMITTER_NAME: 'DeepSpace Workspace',
            GIT_COMMITTER_EMAIL: 'workspace@deep.space',
          }
      const merge = runGit(appDir, ['merge', '--no-edit', remoteRef], {
        allowFail: true,
        env: identEnv,
      })
      if (merge.status !== 0) {
        const conflicted =
          runGit(appDir, ['ls-files', '-u'], { allowFail: true })
            .stdout.toString('utf-8')
            .trim() !== ''
        if (!conflicted) {
          runGit(appDir, ['merge', '--abort'], { allowFail: true })
          spinner?.stop('Merge failed.')
          throw new Refusal(
            `Merging trunk (${intoBranch}) failed (not a conflict): ${merge.stderr.toString('utf-8').trim() || 'unknown git error'}.`,
            'merge_failed',
          )
        }
        spinner?.stop('Merge conflict.')
        throw new Refusal(
          `Merging trunk (${intoBranch}) hit conflicts. Resolve them, \`git add\` + \`git commit\` (validate the merged tree — a marker-free merge can still be semantically wrong), then re-run \`${resumeNext}\`. Your original line is safe on ${view.workspace.ref}.`,
          'merge_conflict',
          {
            actionRequired: true,
            action: recoveryAction,
            extra: { workspaceId: id, conflict: true },
          },
        )
      }
    }

    if (resolveCommit(appDir, 'HEAD^2') !== null) {
      const markerCheck = runGit(appDir, ['diff', '--check', 'HEAD^', 'HEAD'], {
        allowFail: true,
      })
      const markerOutput = markerCheck.stdout.toString('utf-8')
      if (hasLeftoverConflictMarkers(markerOutput)) {
        const files = conflictMarkerFiles(markerOutput)
        spinner?.stop('Conflict markers in merge.')
        throw new Refusal(
          `The merge commit still contains unresolved conflict markers (<<<<<<< / ======= / >>>>>>>)${files.length ? ` in ${files.join(', ')}` : ''}. Fix the marked files, commit the correction, then re-run \`${resumeNext}\`. Nothing was pushed to ${intoBranch}.`,
          'conflict_markers',
          {
            actionRequired: true,
            action: recoveryAction,
            extra: { workspaceId: id, conflict: true, ...(files.length ? { files } : {}) },
          },
        )
      }
    }

    const landedOid = resolveCommit(appDir, 'HEAD')!
    let validationResult: {
      passed: boolean
      command: string
      durationMs: number
      outputTail?: string
    } | null = null
    if (validate) {
      const command = resolveValidationCommand(appDir)
      if (!command) {
        spinner?.stop('No validation command.')
        throw new Refusal(
          'No validation command for --validate. Add a "validate" script to package.json (e.g. "vitest run"), or land without --validate.',
          'no_validate_command',
        )
      }
      spinner?.message(`Validating: ${command}`)
      const run = runValidationCommand(appDir, command)
      const headAfter = resolveCommit(appDir, 'HEAD')
      const dirtyAfter = !isWorkTreeClean(appDir)
      const outputTail = run.output.slice(-2000) || run.summary || undefined
      validationResult = {
        passed: run.passed,
        command,
        durationMs: run.durationMs,
        ...(run.passed ? {} : { outputTail }),
      }
      if (!run.passed) {
        spinner?.stop('Validation failed.')
        throw new Refusal(
          `Validation FAILED on the merged tree (exit ${run.exitStatus ?? '?'}) — the merge is local and nothing was pushed to ${intoBranch}. Fix it, commit, then re-run \`${resumeNext}\`. Your original line is safe on ${view.workspace.ref}.`,
          'validation_failed',
          {
            actionRequired: true,
            action: recoveryAction,
            extra: { workspaceId: id, passed: false, outputTail },
          },
        )
      }
      if (headAfter !== landedOid || dirtyAfter) {
        spinner?.stop('Validation changed the tree.')
        throw new Refusal(
          `Validation modified the working tree or HEAD (a formatter, \`eslint --fix\`, codegen, or a snapshot update). ` +
            `Nothing was pushed to ${intoBranch}: landing would publish ${landedOid.slice(0, 10)} and exclude those changes. ` +
            `Review and commit them (or revert), then re-run \`${resumeNext}\`. Your original line is safe on ${view.workspace.ref}.`,
          'validation_mutated_tree',
          {
            actionRequired: true,
            action: recoveryAction,
            extra: { workspaceId: id },
          },
        )
      }
    }

    const trunkSecret = committedSecretRefusal(appDir, resolveCommit(appDir, 'HEAD'), {
      action: `land onto ${intoBranch}`,
      then: 're-run the land',
      // The fetched trunk tip is what this push uploads against, so the scan
      // covers exactly the commits the merge carries onto trunk — the same
      // range the server scans.
      base: remoteTip,
    })
    if (trunkSecret) {
      spinner?.stop('Secret in history.')
      throw new Refusal(trunkSecret.message, trunkSecret.code, {
        extra: { workspaceId: id },
      })
    }
    const push = pushToSpace(appDir, token, `HEAD:${intoRef}`)
    if (push.status === 'ref_conflict' || push.status === 'non_fast_forward') {
      spinner?.stop('Trunk moved.')
      throw new Refusal(
        // The machine token belongs in `code`, not mid-sentence: the reason
        // arrives as `<code>: <sentence>`, and printing it raw put
        // "stale_ref: stale ref, fetch first" inside human prose.
        `${intoBranch} moved while you merged (${
          parseRefusalCode(push.reason ?? push.summary)?.sentence ?? push.reason ?? push.summary
        }). Re-run \`${resumeNext}\` to integrate the new tip.`,
        'trunk_moved',
        {
          actionRequired: true,
          action: recoveryAction,
          extra: { workspaceId: id },
        },
      )
    }
    if (push.status === 'rejected') {
      spinner?.stop('Push rejected.')
      // Same classification `push` and `workspace sync` use: the reason text
      // carries the stably-distinguishable conditions, and the raw reason on
      // its own gave an agent a code it could not branch on and no advice.
      throw new Refusal(
        pushFailureMessage('The land push', push, appDir),
        classifyRejection(push.reason ?? push.summary ?? '', appDir).code,
      )
    }

    // The push already moved `intoBranch`. If recording it fails — a network
    // blip, a racing land — the CLI must say so: reporting a bare failure
    // here would claim nothing happened while trunk carries the work.
    try {
      await api.landWorkspace(id, { landedOid, intoRef })
    } catch (err) {
      // A finished workspace is a terminal answer, not a recording hiccup: a
      // concurrent land or drop won the race while we merged. Re-running
      // could never record it, so no resume action. The status re-read below
      // keeps this from swallowing an unrelated failure.
      const code = errorCode(err)
      if (code === 'workspace_not_active') {
        const status = await api
          .getWorkspace(id)
          .then((r) => r.view.workspace.status)
          .catch(() => null)
        if (status && status !== 'active') {
          spinner?.stop('Workspace finished.')
          // Exit 2 with the drop action: trunk DID move (the contract keeps
          // partial-success claims out of exit 1), and cleaning up the
          // leftover checkout is the one deterministic step that remains —
          // drop's trunk-tip proof accepts a branch the merge contains.
          throw new Refusal(
            `${intoBranch} took the land push (${landedOid.slice(0, 10)}), and the workspace is already ${status} — a concurrent land or drop finished first, so there is nothing left to record. This checkout is a leftover; \`deepspace workspace drop ${id}\` cleans it up.`,
            'workspace_not_active',
            {
              actionRequired: true,
              action: dropAction,
              extra: { workspaceId: id, into: intoBranch, landedOid, pushed: true, status },
            },
          )
        }
      }
      spinner?.stop('Landed; not recorded.')
      const detail = err instanceof Error ? err.message : String(err)
      throw new Refusal(
        `The land push succeeded (${intoBranch} was at ${landedOid.slice(0, 10)}), but recording the land failed (${detail}). Resolve that, then re-run \`${resumeNext}\` — it re-checks the merge (a no-op when already pushed) and records it.`,
        'land_unrecorded',
        {
          actionRequired: true,
          action: recoveryAction,
          extra: { workspaceId: id, into: intoBranch, landedOid, pushed: true },
        },
      )
    }
    spinner?.stop(`Landed ${id} into ${intoBranch} at ${landedOid.slice(0, 10)}.`)
    // Read the trunk checkout's state BEFORE cleanup: cleanup can remove the
    // very worktree we are standing in, and a git call afterwards runs with a
    // deleted cwd — which surfaces as ENOENT and would report a SUCCESSFUL
    // land (trunk moved, workspace recorded) as a hard failure.
    const trunkCheckoutDir = staleTrunkCheckout(appDir, intoBranch, landedOid)
    const localTrunkBehind = trunkCheckoutDir !== null
    // Pin the continuation NOW as well: cleanup can also remove the managed
    // worktree holding the npx-installed entry this process runs from, and the
    // shared output runtime resolves the action's interpreter only at print
    // time — too late.
    const action = trunkCheckoutDir
      ? staleTrunkPullAction(
          trunkCheckoutDir,
          intoBranch,
          typeof args.app === 'string' ? args.app : undefined,
        )
      : null
    const cleanup = keepWorktree
      ? null
      : cleanupWorkspaceLocal(appDir, id, intoBranch, { expectedBranchOid: landedOid })
    const inOwnWorktree = !cleanup && inOwnLinkedWorktree(appDir, id)
    const retainedWorktree =
      cleanup?.worktreeRetained ?? (keepWorktree || inOwnWorktree ? appDir : null)
    const data = {
      workspaceId: id,
      into: intoBranch,
      landedOid,
      ...(localTrunkBehind ? { localTrunkBehind: true } : {}),
      ...(validationResult ? { validation: validationResult } : {}),
      ...(retainedWorktree ? { worktree: retainedWorktree } : {}),
      ...(cleanup ? { cleanup: cleanupJson(cleanup) } : {}),
    }
    if (!args.json && cleanup && !cleanup.error) {
      reportCleanupHuman(cleanup)
    } else if (!args.json && retainedWorktree) {
      p.log.info(`Retained checkout: ${retainedWorktree}`)
    }
    if (!args.json && localTrunkBehind) {
      p.log.info(
        `Local ${intoBranch} in ${trunkCheckoutDir} is behind the landed merge — run \`deepspace pull\` there to catch up.`,
      )
    }
    if (cleanup?.error) {
      const action = cleanupAction({
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
    return { data, ...(action ? { action } : {}) }
  },
})
