import * as p from '@clack/prompts'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { ensureToken } from '../../auth'
import { findAppDir } from '../../lib/app-context'
import { parseAppArg, resolveAppTarget } from '../../lib/app-target'
import { defineDeepspaceCommand, Refusal } from '../../lib/command'
import { runGit } from '../../lib/git/process'
import { resolveCommit, switchToNewBranch } from '../../lib/git/repository'
import { isWorkspaceId, workspaceBranchName } from '../../lib/workspace-id'
import { deployBaseUrl, ensureSpaceRemote, runGitRemote, SPACE_REMOTE } from '../../lib/vc-remote'
import { repoApi, type RemoteWorkspaceView } from '../../lib/repo-api'
import { createSpinner } from '../../lib/spinner'
import { errorCode } from '../../lib/cli-errors'
import type { CliAction } from '../../lib/output'
import { detectPackageManager } from '../../lib/package-manager'
import { appDirInWorktree, defaultWorkspaceRoot, materializeWorkspaceWorktree } from './local'
import { APP_ARG, resolveTarget } from './runtime'

/** Explain why a finished workspace cannot be attached. */
export function finishedWorkspaceMessage(id: string, view: RemoteWorkspaceView): string {
  const workspace = view.workspace
  if (workspace.status === 'landed') {
    return (
      `Workspace ${id} landed at ${workspace.landedOid?.slice(0, 10) ?? 'an unrecorded commit'} and its ref was deleted — ` +
      `its whole line is reachable through that merge commit (\`git log ${workspace.landedOid ?? '<oid>'}\`). ` +
      `Attach only works on active workspaces; start a new one for follow-up work.`
    )
  }
  return (
    `Workspace ${id} is ${workspace.status} — its ref is retained briefly (fetch ${workspace.ref} to inspect), ` +
    `but attach only works on active workspaces.`
  )
}

/**
 * Reap a failed fresh attach only when the target still contains nothing but
 * the repository metadata this command created. Any checkout file or
 * concurrent write makes the directory user-owned and therefore untouchable.
 */
export function cleanFailedFreshAttachDir(dir: string): string[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return ['<unreadable>']
  }
  if (entries.length > 0 && !(entries.length === 1 && entries[0] === '.git')) {
    return entries
  }
  try {
    rmSync(dir, { recursive: true, force: true })
    return []
  } catch {
    return entries.length > 0 ? entries : ['<cleanup-failed>']
  }
}

export const attachWorkspaceCommand = defineDeepspaceCommand({
  meta: {
    name: 'attach',
    description: 'Resume a workspace here (another machine or a fresh sandbox)',
  },
  args: {
    id: { type: 'positional', description: 'Workspace id (ws_…)', required: true },
    dir: {
      type: 'positional',
      description: 'Directory (worktree or fresh clone target)',
      required: false,
    },
    app: APP_ARG,
  },
  async run({ args }) {
    const id = String(args.id).trim()
    if (!isWorkspaceId(id)) {
      throw new Refusal(`Invalid workspace id: ${id} (expected ws_<ULID>).`, 'invalid_workspace')
    }
    const branch = workspaceBranchName(id)
    const insideRepo = findAppDir()
    const appArg = typeof args.app === 'string' ? args.app : undefined
    const { app: appSelector, error: appError } = parseAppArg(appArg)
    if (appError) throw new Refusal(appError, 'invalid_app')
    if (!insideRepo && appSelector === undefined) {
      throw new Refusal(
        'Not inside an app repo — pass the app explicitly: deepspace workspace attach <ws_id> [dir] -a <app id or name>.',
        'not_in_app_repo',
      )
    }

    const spinner = args.json ? null : createSpinner()
    spinner?.start(`Preparing to attach ${id}…`)

    if (insideRepo) {
      const { appDir, appId, api, token } = await resolveTarget(appArg)
      spinner?.message(`Attaching ${id}…`)
      const { view } = await api.getWorkspace(id)
      if (view.workspace.status !== 'active') {
        spinner?.stop('Workspace finished.')
        throw new Refusal(finishedWorkspaceMessage(id, view), 'workspace_not_active', {
          extra: { status: view.workspace.status },
        })
      }
      ensureSpaceRemote(appDir, appId)
      runGitRemote(appDir, token, [
        'fetch',
        '--quiet',
        SPACE_REMOTE,
        `+${view.workspace.ref}:${view.workspace.ref}`,
      ])
      const tip = view.tipOid ?? view.workspace.baseOid
      if (!resolveCommit(appDir, tip)) {
        spinner?.stop('Fetch failed.')
        throw new Refusal(
          `Could not fetch ${view.workspace.ref} from the cloud repo. Retry; if it persists, report it with \`deepspace feedback\`.`,
          'fetch_failed',
        )
      }
      const requestedDir = typeof args.dir === 'string' ? args.dir.trim() : ''
      const worktreeRoot = requestedDir
        ? isAbsolute(requestedDir)
          ? requestedDir
          : resolve(appDir, requestedDir)
        : defaultWorkspaceRoot(appDir, id)
      const dir = appDirInWorktree(appDir, worktreeRoot)
      if (resolveCommit(appDir, `refs/heads/${branch}`)) {
        throw new Refusal(
          `Branch ${branch} already exists locally (this workspace has a worktree here). Find it with \`git worktree list\` and continue there.`,
          'branch_exists',
        )
      }
      materializeWorkspaceWorktree(appDir, worktreeRoot, branch, tip, id)
      spinner?.stop(`Attached ${id}.`)
      if (!args.json) {
        p.log.info(`Task: ${view.workspace.task}`)
        p.log.info(`Work in: cd ${dir}`)
      }
      const action: CliAction = { cwd: dir, argv: [detectPackageManager(dir), 'install'] }
      return {
        data: {
          workspaceId: id,
          mode: 'worktree',
          dir,
          worktreeRoot,
          branch,
          tipOid: tip,
          task: view.workspace.task,
        },
        action,
      }
    }

    // Fresh-clone mode materializes only this workspace's hidden ref.
    const token = await ensureToken()
    const appId = await resolveAppTarget(deployBaseUrl(), token, appSelector)
    const api = repoApi(deployBaseUrl(), token, appId)
    spinner?.message(`Attaching ${id} into a fresh clone…`)
    const { view } = await api.getWorkspace(id)
    if (view.workspace.status !== 'active') {
      spinner?.stop('Workspace finished.')
      throw new Refusal(finishedWorkspaceMessage(id, view), 'workspace_not_active', {
        extra: { status: view.workspace.status },
      })
    }
    const dir = resolve(
      process.cwd(),
      (typeof args.dir === 'string' ? args.dir.trim() : '') || `ws-${id.slice(3).toLowerCase()}`,
    )
    if (existsSync(dir)) {
      spinner?.stop('Target exists.')
      throw new Refusal(`${dir} already exists — pass a different directory.`, 'dir_exists')
    }
    const failFreshAttach = (message: string, code?: string): never => {
      const leftovers = cleanFailedFreshAttachDir(dir)
      const cleanupNote =
        leftovers.length > 0
          ? ` The failed attach left ${dir} in place because it contains: ${leftovers.join(', ')}.`
          : ''
      throw new Refusal(message + cleanupNote, code ?? 'attach_failed', {
        extra: leftovers.length > 0 ? { leftovers } : undefined,
      })
    }
    let tip: string
    try {
      runGit(process.cwd(), ['init', '--quiet', dir])
      ensureSpaceRemote(dir, appId)
      runGitRemote(dir, token, [
        'fetch',
        '--quiet',
        SPACE_REMOTE,
        `+${view.workspace.ref}:${view.workspace.ref}`,
      ])
      tip = view.tipOid ?? view.workspace.baseOid
      if (!resolveCommit(dir, tip)) {
        spinner?.stop('Fetch failed.')
        return failFreshAttach(
          `Could not fetch ${view.workspace.ref} from the cloud repo. Retry; if it persists, report it with \`deepspace feedback\`.`,
          'fetch_failed',
        )
      }
      switchToNewBranch(dir, branch, tip)
    } catch (error) {
      if (error instanceof Refusal) throw error
      return failFreshAttach(
        error instanceof Error ? error.message : String(error),
        errorCode(error),
      )
    }
    spinner?.stop(`Attached ${id}.`)
    const action: CliAction = { cwd: dir, argv: [detectPackageManager(dir), 'install'] }
    if (!args.json) {
      p.log.info(`Task: ${view.workspace.task}`)
      p.log.info('Pull app secrets after install if this workspace needs them.')
    }
    return {
      data: {
        workspaceId: id,
        mode: 'clone',
        dir,
        branch,
        tipOid: tip,
        task: view.workspace.task,
      },
      action,
    }
  },
})
