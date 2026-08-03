import * as p from '@clack/prompts'
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { shQuote } from '../../lib/cli-format'
import { runGit } from '../../lib/git/process'
import {
  addWorktreeNewBranch,
  currentBranch,
  ensureLocalExclude,
  listWorktrees,
  repoToplevel,
  resolveCommit,
} from '../../lib/git/repository'
import { workspaceBranchName, workspaceIdFromBranch } from '../../lib/workspace-id'

const WORKSPACE_MARKER = 'deepspace-workspace.json'

interface ManagedWorkspaceMarker {
  version: 1
  workspaceId: string
  mode: 'managed-linked'
}

export function excludeWorktreeDir(appDir: string, dir: string): void {
  try {
    ensureLocalExclude(appDir, '.deepspace/')
    const realDir = realpathSync(dir)
    const rel = relative(realpathSync(repoToplevel(appDir)), realDir)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return
    const pattern = rel.split(sep).join('/')
    if (pattern === '.deepspace' || pattern.startsWith('.deepspace/')) return
    const relApp = relative(realpathSync(appDir), realDir).split(sep).join('/')
    if (relApp === '.deepspace' || relApp.startsWith('.deepspace/')) return
    ensureLocalExclude(appDir, `/${pattern}/`)
  } catch {
    // Local exclusion is best-effort; failure only makes git status noisier.
  }
}

function worktreeMarkerPath(worktreeRoot: string): string | null {
  try {
    const result = runGit(worktreeRoot, ['rev-parse', '--absolute-git-dir'], { allowFail: true })
    if (result.status !== 0) return null
    const gitDir = result.stdout.toString('utf-8').trim()
    return isAbsolute(gitDir) ? join(gitDir, WORKSPACE_MARKER) : null
  } catch {
    return null
  }
}

function markManagedWorkspace(worktreeRoot: string, workspaceId: string): boolean {
  const markerPath = worktreeMarkerPath(worktreeRoot)
  if (!markerPath) return false
  const marker: ManagedWorkspaceMarker = { version: 1, workspaceId, mode: 'managed-linked' }
  const tempPath = `${markerPath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(tempPath, JSON.stringify(marker) + '\n')
    renameSync(tempPath, markerPath)
    return true
  } catch {
    return false
  }
}

function rollbackUnmarkedWorkspace(
  appDir: string,
  worktreeRoot: string,
  branch: string,
  createdOid: string,
): string | null {
  const removed = runGit(appDir, ['worktree', 'remove', worktreeRoot], { allowFail: true })
  if (removed.status !== 0) {
    return `git worktree remove failed: ${removed.stderr.toString('utf-8').trim() || 'unknown git error'}`
  }
  const deleted = runGit(appDir, ['update-ref', '-d', `refs/heads/${branch}`, createdOid], {
    allowFail: true,
  })
  if (deleted.status !== 0) {
    return `the checkout was removed but branch ${branch} remains: ${deleted.stderr.toString('utf-8').trim() || 'unknown git error'}`
  }
  return null
}

/** Only a private Git-admin marker proves that DeepSpace owns this checkout. */
export function isManagedWorkspaceWorktree(worktreeRoot: string, workspaceId: string): boolean {
  const markerPath = worktreeMarkerPath(worktreeRoot)
  if (!markerPath) return false
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as Partial<ManagedWorkspaceMarker>
    return (
      marker.version === 1 && marker.workspaceId === workspaceId && marker.mode === 'managed-linked'
    )
  } catch {
    return false
  }
}

/** Stable default independent of whichever Codex/Claude/native checkout invoked us. */
export function defaultWorkspaceRoot(appDir: string, workspaceId: string): string {
  const primary = listWorktrees(appDir)[0]
  if (!primary) throw new Error('Git did not report a primary worktree')
  return join(primary.path, '.deepspace', 'ws', workspaceId.slice(3).toLowerCase())
}

/** Map the app's repo-relative location into a newly checked-out whole repository. */
export function appDirInWorktree(appDir: string, worktreeRoot: string): string {
  const appRelative = relative(realpathSync(repoToplevel(appDir)), realpathSync(appDir))
  return appRelative ? join(worktreeRoot, appRelative) : worktreeRoot
}

/** Create a local workspace checkout and apply its standard local setup. */
export function materializeWorkspaceWorktree(
  appDir: string,
  worktreeRoot: string,
  branch: string,
  startPoint: string,
  workspaceId: string,
  options: { markManaged?: (worktreeRoot: string, workspaceId: string) => boolean } = {},
): void {
  const createdOid = resolveCommit(appDir, startPoint)
  if (!createdOid) throw new Error(`Could not resolve workspace start point ${startPoint}`)
  addWorktreeNewBranch(appDir, worktreeRoot, branch, startPoint)
  const marked = (options.markManaged ?? markManagedWorkspace)(worktreeRoot, workspaceId)
  if (!marked) {
    const rollbackError = rollbackUnmarkedWorkspace(appDir, worktreeRoot, branch, createdOid)
    throw new Error(
      `Could not record DeepSpace ownership for ${worktreeRoot}.` +
        (rollbackError
          ? ` Automatic rollback was incomplete: ${rollbackError}`
          : ' The just-created checkout and branch were rolled back.'),
    )
  }
  excludeWorktreeDir(appDir, worktreeRoot)
}

export function inOwnLinkedWorktree(appDir: string, id: string): boolean {
  if (workspaceIdFromBranch(currentBranch(appDir)) !== id) return false
  try {
    return statSync(join(repoToplevel(appDir), '.git')).isFile()
  } catch {
    return false
  }
}

export interface CleanupOutcome {
  worktreeRemoved: string | null
  worktreeRetained: string | null
  branchDeleted: string | null
  mainDir?: string
  error?: string
  worktreeDir: string | null
  branch: string
}

export function cleanupJson(outcome: CleanupOutcome): Record<string, unknown> {
  return {
    worktreeRemoved: outcome.worktreeRemoved,
    worktreeRetained: outcome.worktreeRetained,
    branchDeleted: outcome.branchDeleted,
    ...(outcome.mainDir ? { mainDir: outcome.mainDir } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  }
}

function deleteWsBranch(cwd: string, branch: string, out: CleanupOutcome): void {
  const del = runGit(cwd, ['branch', '-D', branch], { allowFail: true })
  if (del.status === 0) out.branchDeleted = branch
  else
    out.error ??= `git branch -D ${branch} failed: ${del.stderr.toString('utf-8').trim() || 'unknown git error'}`
}

function switchOffWsBranch(mainDir: string, trunkBranch: string | null): boolean {
  if (trunkBranch) {
    if (resolveCommit(mainDir, `refs/heads/${trunkBranch}`)) {
      return runGit(mainDir, ['switch', '--quiet', trunkBranch], { allowFail: true }).status === 0
    }
    const remote = resolveCommit(mainDir, `refs/remotes/space/${trunkBranch}`)
    if (remote) {
      return (
        runGit(mainDir, ['switch', '--quiet', '-c', trunkBranch, remote], { allowFail: true })
          .status === 0
      )
    }
  }
  return runGit(mainDir, ['switch', '--quiet', '--detach'], { allowFail: true }).status === 0
}

export function cleanupWorkspaceLocal(
  appDir: string,
  id: string,
  trunkBranch: string | null,
): CleanupOutcome {
  const branch = workspaceBranchName(id)
  const out: CleanupOutcome = {
    worktreeRemoved: null,
    worktreeRetained: null,
    branchDeleted: null,
    worktreeDir: null,
    branch,
  }
  try {
    const worktrees = listWorktrees(appDir)
    const mainDir = worktrees[0]?.path ?? repoToplevel(appDir)
    const linked = worktrees.find((worktree, index) => index > 0 && worktree.branch === branch)
    if (linked) {
      out.worktreeDir = linked.path
      if (!isManagedWorkspaceWorktree(linked.path, id)) {
        out.worktreeRetained = linked.path
        return out
      }
      let inside = false
      try {
        inside = realpathSync(repoToplevel(appDir)) === realpathSync(linked.path)
      } catch {
        inside = false
      }
      if (inside) {
        process.chdir(mainDir)
        out.mainDir = mainDir
      }
      const remove = runGit(mainDir, ['worktree', 'remove', linked.path], { allowFail: true })
      if (remove.status !== 0) {
        out.error = `git worktree remove ${linked.path} failed: ${remove.stderr.toString('utf-8').trim() || 'unknown git error'}`
        return out
      }
      out.worktreeRemoved = linked.path
      deleteWsBranch(mainDir, branch, out)
      return out
    }
    if (currentBranch(mainDir) === branch && !switchOffWsBranch(mainDir, trunkBranch)) {
      out.error = `could not switch off ${branch} to delete it`
      return out
    }
    if (resolveCommit(mainDir, `refs/heads/${branch}`)) deleteWsBranch(mainDir, branch, out)
    return out
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err)
    return out
  }
}

export function cleanupRefusalMessage(outcome: {
  error: string
  worktreeDir: string | null
  branch: string
}): string {
  if (outcome.worktreeDir) {
    const dir = shQuote(outcome.worktreeDir)
    return (
      `Cleanup incomplete: ${outcome.error}. The worktree at ${dir} still holds uncommitted or untracked work — ` +
      `that's why the plain removal refused. Inspect it (\`git -C ${dir} status\`) and commit anything worth ` +
      `keeping to the workspace branch. Once it's clean, remove it from the main checkout: \`git worktree remove ${dir}\`.`
    )
  }
  return `Cleanup incomplete: ${outcome.error}. Finish it from the main checkout once ${shQuote(outcome.branch)} is safe to delete.`
}

export function cleanupAction(outcome: { worktreeDir: string | null; branch: string }): {
  cwd: string
  argv: string[]
} {
  return outcome.worktreeDir
    ? { cwd: outcome.worktreeDir, argv: ['git', 'status'] }
    : { cwd: process.cwd(), argv: ['git', 'branch', '--list', outcome.branch] }
}

export function reportCleanupHuman(outcome: CleanupOutcome): void {
  if (outcome.error) {
    p.log.warn(
      cleanupRefusalMessage({
        error: outcome.error,
        worktreeDir: outcome.worktreeDir,
        branch: outcome.branch,
      }),
    )
    return
  }
  const parts = [
    outcome.worktreeRemoved ? 'worktree' : null,
    outcome.branchDeleted ? `branch ${outcome.branch}` : null,
  ].filter(Boolean)
  if (parts.length) p.log.success(`Removed ${parts.join(' + ')}.`)
  if (outcome.worktreeRetained) {
    p.log.info(`Retained externally managed worktree: ${outcome.worktreeRetained}`)
  }
  if (outcome.worktreeRemoved && outcome.mainDir) {
    p.log.info(`This directory was removed — run: cd ${shQuote(outcome.mainDir)}`)
  }
}
