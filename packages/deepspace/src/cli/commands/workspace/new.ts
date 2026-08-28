import * as p from '@clack/prompts'
import { isAbsolute, resolve } from 'node:path'
import { findAppDir } from '../../lib/app-context'
import { mintUlid } from '../../../server/utils/registry-client'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import { resolveCommit } from '../../lib/git/repository'
import { workspaceBranchName } from '../../lib/workspace-id'
import { ensureSpaceRemote } from '../../lib/vc-remote'
import { mintIdempotencyKey } from '../../lib/repo-api'
import { createSpinner } from '../../lib/spinner'
import { detectPackageManager } from '../../lib/package-manager'
import type { CliAction } from '../../lib/output'
import { fetchTrunk } from './analysis'
import { appDirInWorktree, defaultWorkspaceRoot, materializeWorkspaceWorktree } from './local'
import { APP_ARG, resolveTarget } from './runtime'

export const newWorkspaceCommand = defineDeepspaceCommand({
  meta: { name: 'new', description: 'Create a workspace: server-side ref + local worktree' },
  args: {
    task: {
      type: 'string',
      alias: 't',
      // NOT citty-required: a missing required arg makes citty print human
      // usage text even under --json. Validated in run() for a JSON refusal.
      description: 'What this workspace is for (shown to every collaborator/agent; required)',
      required: false,
    },
    base: {
      type: 'string',
      description: 'Base revision (default: the cloud repo trunk tip)',
      required: false,
    },
    dir: {
      type: 'string',
      description: 'Worktree directory (default: .deepspace/ws/<id>)',
      required: false,
    },
    app: APP_ARG,
  },
  async run({ args }) {
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    // A flag-shaped task is the NEXT flag swallowed by a bare `-t`
    // (`workspace new -t --json` created a real server-side workspace
    // literally named "--json" — 2026-08-28 lifecycle AX BUG-2). No real
    // task starts with `-`; one message covers both empty and swallowed.
    if (!task || task.startsWith('-')) {
      throw new Refusal(
        'A workspace needs a task — pass -t "<what this workspace is for>" (quote it, and put ' +
          'flags like --json after it; it is shown to every collaborator and agent).',
        'invalid_task',
      )
    }
    const baseArg = typeof args.base === 'string' ? args.base.trim() : ''
    // Validate an explicit --base before auth: it is a local input error.
    if (baseArg) {
      const baseDir = findAppDir()
      if (baseDir && !resolveCommit(baseDir, baseArg)) {
        throw new Refusal(
          `--base ${String(args.base)} does not resolve to a local commit.`,
          'invalid_base',
        )
      }
    }
    const spinner = args.json ? null : createSpinner()
    spinner?.start('Preparing workspace…')
    const { appDir, appId, token, api } = await resolveTarget(
      typeof args.app === 'string' ? args.app : undefined,
    )
    spinner?.message('Creating workspace…')

    // A GitHub-source app is refused by the SERVER at this read
    // (`source_managed_by_github` — a registry field check; source latches
    // permanently at the first release), before ensureSpaceRemote below, so
    // the refusal mutates nothing.
    // Prefer the requested revision, then cloud trunk, then local HEAD for an empty cloud repo.
    let baseOid: string | null = null
    const refs = await api.getRefs()
    // The new worktree exists to be committed in ("Then: commit as usual"),
    // so the token goes in: ensureSpaceRemote gives it an identity too.
    ensureSpaceRemote(appDir, appId, undefined, token)
    if (baseArg) {
      baseOid = resolveCommit(appDir, baseArg)
      if (!baseOid) {
        spinner?.stop('Base not found.')
        throw new Refusal(
          `--base ${String(args.base)} does not resolve to a local commit.`,
          'invalid_base',
        )
      }
    } else {
      const trunk = refs?.head ? refs.refs.find((ref) => ref.name === refs.head) : undefined
      if (trunk) {
        baseOid = trunk.oid
        if (!resolveCommit(appDir, baseOid)) fetchTrunk(appDir, token, refs!.head)
        if (!resolveCommit(appDir, baseOid)) {
          spinner?.stop('Base not fetchable.')
          throw new Refusal(
            `Could not fetch the trunk tip ${baseOid.slice(0, 10)} from the cloud repo. Retry; if it persists, report it with \`deepspace feedback\`.`,
            'fetch_failed',
          )
        }
      } else {
        baseOid = resolveCommit(appDir, 'HEAD')
        if (!baseOid) {
          spinner?.stop('No base.')
          throw new Refusal(
            'The repo has no commits yet — commit first, then create a workspace.',
            'no_commits',
          )
        }
      }
    }

    const id = `ws_${mintUlid()}`
    const branch = workspaceBranchName(id)
    const { view } = await api.createWorkspace({
      workspaceId: id,
      task,
      baseOid,
      idempotencyKey: mintIdempotencyKey(),
    })

    const dirInput = typeof args.dir === 'string' ? args.dir.trim() : ''
    const worktreeRoot = dirInput
      ? isAbsolute(dirInput)
        ? dirInput
        : resolve(appDir, dirInput)
      : defaultWorkspaceRoot(appDir, id)
    const dir = appDirInWorktree(appDir, worktreeRoot)
    try {
      materializeWorkspaceWorktree(appDir, worktreeRoot, branch, baseOid, id)
    } catch (error) {
      spinner?.stop('Worktree failed.')
      const reason = error instanceof Error ? error.message : String(error)
      throw new Refusal(
        `Workspace ${id} was created in the cloud, but the local worktree could not be set up: ${reason} — attach it with \`deepspace workspace attach ${id} <dir>\` (or drop it: \`deepspace workspace drop ${id}\`).`,
        'worktree_setup_failed',
        { extra: { workspaceId: id, ref: view.workspace.ref, baseOid } },
      )
    }

    spinner?.stop(`Workspace ${id} created.`)
    if (!args.json) {
      p.log.info(`Work in: cd ${dir}`)
      p.log.info(
        `Then: commit as usual, \`deepspace workspace sync\` to publish, \`deepspace workspace land\` when done.`,
      )
    }
    const action: CliAction = { cwd: dir, argv: [detectPackageManager(dir), 'install'] }
    return {
      data: {
        workspaceId: id,
        appId,
        ref: view.workspace.ref,
        baseOid,
        branch,
        dir,
        worktreeRoot,
      },
      action,
    }
  },
})
