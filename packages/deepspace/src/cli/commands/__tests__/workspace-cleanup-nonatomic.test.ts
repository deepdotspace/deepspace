/**
 * `git worktree remove` is NOT atomic on Windows: one locked file (a running
 * dev server's workerd.exe, say) makes git deregister the worktree — delete
 * `.git/worktrees/<name>` and the checkout's `.git` link — and only THEN fail
 * deleting the remaining files, exiting non-zero. Cleanup must not read that
 * exit code as "nothing happened": the branch teardown must still run, and the
 * reported remedy must match the actual state (an orphan directory, not a
 * still-registered worktree).
 *
 * The partial state is reproduced deterministically here (on every platform)
 * by intercepting exactly the `worktree remove` invocation and performing the
 * deregistration git was observed to do on Windows before failing.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shQuote } from '../../lib/cli-format'
import {
  cleanupAction,
  cleanupJson,
  cleanupRefusalMessage,
  cleanupWorkspaceLocal,
  materializeWorkspaceWorktree,
} from '../workspace/local'

// Real-git suite: shells out to git in scratch repos; see workspace.test.ts.

type RunGitResult = { stdout: Buffer; stderr: Buffer; status: number }

const hook = vi.hoisted(() => ({
  onWorktreeRemove: null as ((cwd: string, args: string[]) => RunGitResult | undefined) | null,
  /** Make `worktree list` fail from the Nth call onward (1-based), so the
   *  post-failure re-check can be broken without breaking the initial lookup. */
  failWorktreeListFrom: null as number | null,
  worktreeListCalls: 0,
}))

vi.mock('../../lib/git/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/git/process')>()
  const runGit: typeof actual.runGit = (cwd, args, opts) => {
    if (hook.onWorktreeRemove && args[0] === 'worktree' && args[1] === 'remove') {
      const faked = hook.onWorktreeRemove(cwd, args)
      if (faked) return faked
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      hook.worktreeListCalls += 1
      if (
        hook.failWorktreeListFrom !== null &&
        hook.worktreeListCalls >= hook.failWorktreeListFrom
      ) {
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('fatal: Unable to create index.lock: File exists\n'),
          status: 128,
        }
      }
    }
    return actual.runGit(cwd, args, opts)
  }
  return { ...actual, runGit }
})

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

/** Compare paths across the porcelain (forward-slash, even on Windows) and
 *  node (native separator) spellings. */
const norm = (p: string): string => p.split('\\').join('/')

const ID = 'ws_01hpartial000000000000abcd'
const BRANCH = `ws/${ID.slice(3).toLowerCase()}`

let repo: string
const ORIG_CWD = process.cwd()
afterEach(() => {
  hook.onWorktreeRemove = null
  hook.failWorktreeListFrom = null
  hook.worktreeListCalls = 0
  process.chdir(ORIG_CWD)
  rmSync(repo, { recursive: true, force: true })
})

function initRepoWithCommit(): string {
  repo = mkdtemp()
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 't@t'])
  git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'f.txt'), 'x\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

function mkdtemp(): string {
  const dir = join(tmpdir(), `ds-ws-nonatomic-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A managed linked worktree on BRANCH at HEAD, at .deepspace/ws/<id>. */
function addWorktree(main: string): string {
  const dir = join(main, '.deepspace', 'ws', ID.slice(3).toLowerCase())
  materializeWorkspaceWorktree(main, dir, BRANCH, 'HEAD', ID)
  return dir
}

/**
 * Arm the interception: the next `git worktree remove` deregisters the
 * worktree exactly as observed on Windows (admin dir and `.git` link gone,
 * tracked files gone), then fails with git's real Windows stderr. With
 * `leaveFiles`, an unremovable-file stand-in survives as an orphan directory.
 */
function simulatePartialRemoval(main: string, dir: string, opts: { leaveFiles: boolean }): void {
  hook.onWorktreeRemove = () => {
    hook.onWorktreeRemove = null
    rmSync(join(main, '.git', 'worktrees'), { recursive: true, force: true })
    if (opts.leaveFiles) {
      rmSync(join(dir, '.git'), { force: true })
      rmSync(join(dir, 'f.txt'), { force: true })
      mkdirSync(join(dir, 'node_modules'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'workerd.exe'), 'still running\n')
    } else {
      rmSync(dir, { recursive: true, force: true })
    }
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`error: failed to delete '${dir}': Invalid argument\n`),
      status: 255,
    }
  }
}

describe('cleanupWorkspaceLocal — non-atomic `git worktree remove` (Windows locked file)', () => {
  it('finishes the branch teardown when the failed remove actually deregistered the worktree', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    const wt = realpathSync(dir)
    simulatePartialRemoval(main, dir, { leaveFiles: true })

    const res = cleanupWorkspaceLocal(main, ID, 'main')

    // The branch must not leak: teardown progressed past the worktree.
    expect(res.branchDeleted).toBe(BRANCH)
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toBe('')
    // Partial is reported as partial: files remain, so nothing claims removal…
    expect(res.worktreeRemoved).toBeNull()
    expect(existsSync(dir)).toBe(true)
    // …and the leftover is named as an orphan, not a still-registered worktree.
    expect(res.worktreeDir).toBeNull()
    expect(norm(res.leftoverDir!)).toBe(norm(wt))
    expect(cleanupJson(res).leftoverDir).toBe(res.leftoverDir)
    // The reason is git's actual stderr, not an invented diagnosis.
    expect(res.error).toContain('Invalid argument')
  })

  it('advises deleting the orphan directory — never git commands inside it', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    const wt = realpathSync(dir)
    simulatePartialRemoval(main, dir, { leaveFiles: true })

    const res = cleanupWorkspaceLocal(main, ID, 'main')
    const msg = cleanupRefusalMessage({
      error: res.error!,
      worktreeDir: res.worktreeDir,
      leftoverDir: res.leftoverDir,
      branch: res.branch,
    })

    // The directory as the outcome itself spells it (git's porcelain form).
    const reported = res.leftoverDir ?? res.worktreeDir
    expect(norm(reported!)).toBe(norm(wt))
    // Both were observed false/broken in the field: the dir is CLEAN by git's
    // account, and `git worktree remove '<dir>'` now fails "not a working tree".
    expect(msg).not.toContain('uncommitted or untracked work')
    expect(msg).not.toContain(`git worktree remove ${shQuote(reported!)}`)
    // The real remedy: delete the leftover directory (named, quoted).
    expect(msg).toContain(shQuote(reported!))
    expect(msg).toMatch(/delete/i)
    expect(msg).not.toContain('--force')

    // Short, and free of invented diagnosis. Nothing here checked WHAT holds
    // the files, so the message must not guess — and it must not bury the one
    // path that matters under repetitions of itself.
    expect(msg).not.toMatch(/\bprobably\b|\busually\b|\blikely\b/i)
    // Sentence count, not character count: total length scales with the user's
    // path (which git spells differently from the porcelain, so it cannot be
    // reliably subtracted). The old message was four sentences that restated
    // each other; this must stay at two — the fact, and the instruction.
    expect(msg.split(/\.\s/).length).toBeLessThanOrEqual(2)

    // The follow-up action must not run git inside a directory that is no
    // longer a repository (git would walk up and describe the wrong repo).
    const action = cleanupAction({
      worktreeDir: res.worktreeDir,
      leftoverDir: res.leftoverDir,
      branch: res.branch,
    })
    expect(realpathSync(action.cwd)).not.toBe(wt)
    expect(action.argv[0]).toBe('git')
  })

  it('reports the removal as complete when the directory is also gone despite the non-zero exit', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    const wt = realpathSync(dir)
    simulatePartialRemoval(main, dir, { leaveFiles: false })

    const res = cleanupWorkspaceLocal(main, ID, 'main')

    expect(res.error).toBeUndefined()
    expect(norm(res.worktreeRemoved!)).toBe(norm(wt))
    expect(res.leftoverDir).toBeUndefined()
    expect(res.branchDeleted).toBe(BRANCH)
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toBe('')
  })

  it('still refuses before the branch delete when the worktree remains registered', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    const wt = realpathSync(dir)
    // Failure with NO deregistration — the POSIX-style refusal. State must be
    // reported exactly as before the non-atomicity fix.
    hook.onWorktreeRemove = () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`fatal: '${dir}' contains modified or untracked files, use --force to delete it\n`),
      status: 128,
    })

    const res = cleanupWorkspaceLocal(main, ID, 'main')

    // Byte-identical refuse-path shape: `git worktree remove <path> failed: <stderr>`.
    expect(res.error).toBe(
      `git worktree remove ${res.worktreeDir} failed: fatal: '${dir}' contains modified or untracked files, use --force to delete it`,
    )
    expect(norm(res.worktreeDir!)).toBe(norm(wt))
    expect(res.leftoverDir).toBeUndefined()
    expect(res.worktreeRemoved).toBeNull()
    expect(res.branchDeleted).toBeNull()
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toContain(BRANCH)
  })

  /**
   * listWorktrees returns [] on ANY non-zero git exit, so "the probe failed" is
   * indistinguishable from "the worktree is gone" unless the empty case is
   * handled explicitly. Reading a failed probe as deregistration would delete
   * the branch out from under a LIVE worktree and then tell the user to delete
   * its directory — strictly worse than the leak this change repairs. Unknown
   * must fail CLOSED.
   */
  it('refuses instead of deleting the branch when the re-check probe itself fails', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    // The remove fails but changes NOTHING — the worktree is alive and intact.
    // Break every `worktree list` from this point on, so only the post-failure
    // re-check is affected and the earlier lookups still resolve normally.
    hook.onWorktreeRemove = () => {
      hook.failWorktreeListFrom = hook.worktreeListCalls + 1
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(`error: failed to delete '${dir}': Invalid argument\n`),
        status: 255,
      }
    }

    const res = cleanupWorkspaceLocal(main, ID, 'main')

    // Must NOT have taken the deregistered path.
    expect(res.branchDeleted).toBeNull()
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toContain(BRANCH)
    expect(res.leftoverDir).toBeUndefined()
    expect(res.worktreeRemoved).toBeNull()
    // And must not tell the user to delete a directory that is still a worktree.
    const msg = cleanupRefusalMessage({
      error: res.error!,
      worktreeDir: res.worktreeDir,
      leftoverDir: res.leftoverDir,
      branch: res.branch,
    })
    expect(msg).not.toMatch(/delete the leftover directory/i)
    expect(existsSync(dir)).toBe(true)
  })

  /**
   * deleteWsBranch reports failures with `out.error ??=`. If the leftover
   * message is set first it wins, and a RETAINED branch — including the
   * compare-and-swap guard firing correctly — is silently discarded, leaving
   * the very leak this change exists to stop.
   */
  it('surfaces a retained branch alongside the leftover directory', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    simulatePartialRemoval(main, dir, { leaveFiles: true })

    // An approved tip that no longer matches: deleteWsBranch must retain the
    // branch and say so, and that must survive into the reported error.
    const res = cleanupWorkspaceLocal(main, ID, 'main', {
      expectedBranchOid: '0000000000000000000000000000000000000000',
    })

    expect(res.branchDeleted).toBeNull()
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toContain(BRANCH)
    // Both facts must reach the user, not just the directory one.
    expect(res.error).toContain('could not delete its files')
    expect(res.error).toContain('retained the branch')
  })
})

describe('cleanupRefusalMessage — diagnosis matches what git actually said', () => {
  it('does not blame uncommitted work when git refused for a different reason', () => {
    const msg = cleanupRefusalMessage({
      error: "git worktree remove /work/ws-a failed: fatal: cannot remove a locked working tree, lock reason: dev",
      worktreeDir: '/work/ws-a',
      branch: 'ws/01hpartial000000000000abcd',
    })
    expect(msg).not.toContain('uncommitted or untracked work')
    // Still registered, so the plain (non-forcing) removal is still the remedy.
    expect(msg).toContain('git worktree remove')
    expect(msg).toContain("'/work/ws-a'")
    expect(msg).not.toContain('--force')
  })
})
