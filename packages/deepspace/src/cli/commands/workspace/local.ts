import * as p from '@clack/prompts'
import { existsSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
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

export function provisionWorktreeDeps(appDir: string, dir: string): string[] {
  const linked: string[] = []
  try {
    const src = join(appDir, 'node_modules')
    const dest = join(dir, 'node_modules')
    if (existsSync(src) && !existsSync(dest)) {
      symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push('node_modules')
    }
  } catch {
    // Best-effort; the workspace can install its own dependencies.
  }
  return linked
}

/** Create a local workspace checkout and apply its standard local setup. */
export function materializeWorkspaceWorktree(
  appDir: string,
  dir: string,
  branch: string,
  startPoint: string,
): string[] {
  addWorktreeNewBranch(appDir, dir, branch, startPoint)
  excludeWorktreeDir(appDir, dir)
  return provisionWorktreeDeps(appDir, dir)
}

export function inOwnLinkedWorktree(appDir: string, id: string): boolean {
  if (workspaceIdFromBranch(currentBranch(appDir)) !== id) return false
  try {
    return statSync(join(appDir, '.git')).isFile()
  } catch {
    return false
  }
}

export interface CleanupOutcome {
  worktreeRemoved: string | null
  branchDeleted: string | null
  mainDir?: string
  error?: string
  worktreeDir: string | null
  branch: string
}

export function cleanupJson(outcome: CleanupOutcome): Record<string, unknown> {
  return {
    worktreeRemoved: outcome.worktreeRemoved,
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
      let inside = false
      try {
        inside = realpathSync(appDir) === realpathSync(linked.path)
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
  if (outcome.worktreeRemoved && outcome.mainDir) {
    p.log.info(`This directory was removed — run: cd ${shQuote(outcome.mainDir)}`)
  }
}
