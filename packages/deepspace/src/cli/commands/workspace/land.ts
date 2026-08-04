import * as p from '@clack/prompts'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import type { CliAction } from '../../lib/output'
import { runGit } from '../../lib/git/process'
import { isPlausibleBranchName, isWorkTreeClean, resolveCommit } from '../../lib/git/repository'
import { committedSecretRefusal } from '../../lib/git/safety'
import { pushToSpace } from '../../lib/vc-push'
import { ensureSpaceRemote, runGitRemote, SPACE_REMOTE } from '../../lib/vc-remote'
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
} from './runtime'

export function hasLeftoverConflictMarkers(diffCheckOutput: string): boolean {
  return /leftover conflict marker/.test(diffCheckOutput)
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
    assertSelectedWorkspaceCheckout(appDir, id, resumeArgv)
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
      throw new Refusal(
        `Workspace ${id} is already ${view.workspace.status}.`,
        'workspace_not_active',
        { extra: { status: view.workspace.status } },
      )
    }
    ensureSpaceRemote(appDir, appId)

    // A conflict retry keeps the pure workspace line immutable: HEAD's first parent is its tip.
    const isResumedMerge =
      resolveCommit(appDir, 'HEAD^2') !== null &&
      view.tipOid !== null &&
      resolveCommit(appDir, 'HEAD^') === view.tipOid
    if (!isResumedMerge) {
      pushWorkspaceRef(appDir, token, view.workspace.ref, headBefore)
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
    const remoteRef = `refs/remotes/space/${intoBranch}`
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
            extra: { workspaceId: id, conflict: true },
          },
        )
      }
    }

    if (resolveCommit(appDir, 'HEAD^2') !== null) {
      const markerCheck = runGit(appDir, ['diff', '--check', 'HEAD^', 'HEAD'], {
        allowFail: true,
      })
      if (hasLeftoverConflictMarkers(markerCheck.stdout.toString('utf-8'))) {
        spinner?.stop('Conflict markers in merge.')
        throw new Refusal(
          `The merge commit still contains unresolved conflict markers (<<<<<<< / ======= / >>>>>>>). Fix the marked files, commit the correction, then re-run \`${resumeNext}\`. Nothing was pushed to ${intoBranch}.`,
          'conflict_markers',
          {
            actionRequired: true,
            extra: { workspaceId: id, conflict: true },
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
            extra: { workspaceId: id },
          },
        )
      }
    }

    const trunkSecret = committedSecretRefusal(appDir, resolveCommit(appDir, 'HEAD'), {
      action: `land onto ${intoBranch}`,
      then: 're-run the land',
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
        `${intoBranch} moved while you merged (${push.reason ?? push.summary}). Re-run \`${resumeNext}\` to integrate the new tip.`,
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
      throw new Refusal(
        `The cloud repo rejected the land push: ${push.reason ?? push.summary}.`,
        'push_rejected',
      )
    }

    await api.landWorkspace(id, { landedOid, intoRef })
    spinner?.stop(`Landed ${id} into ${intoBranch} at ${landedOid.slice(0, 10)}.`)
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
      ...(validationResult ? { validation: validationResult } : {}),
      ...(retainedWorktree ? { worktree: retainedWorktree } : {}),
      ...(cleanup ? { cleanup: cleanupJson(cleanup) } : {}),
    }
    if (!args.json && cleanup && !cleanup.error) {
      reportCleanupHuman(cleanup)
    } else if (!args.json && retainedWorktree) {
      p.log.info(`Retained checkout: ${retainedWorktree}`)
    }
    if (cleanup?.error) {
      const action = cleanupAction({
        worktreeDir: cleanup.worktreeDir,
        branch: cleanup.branch,
      })
      throw new Refusal(
        cleanupRefusalMessage({
          error: cleanup.error,
          worktreeDir: cleanup.worktreeDir,
          branch: cleanup.branch,
        }),
        'cleanup_incomplete',
        { actionRequired: true, action, extra: data },
      )
    }
    return { data }
  },
})
