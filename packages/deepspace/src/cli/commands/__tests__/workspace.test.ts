/**
 * Pure decision helpers behind `deepspace workspace`, plus the local
 * worktree/exclude bookkeeping, against real throwaway repos.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandDef } from 'citty'
import type { RemoteWorkspaceView } from '../../lib/repo-api'
import workspace from '../workspace'
import {
  appDirInWorktree,
  cleanupRefusalMessage,
  cleanupWorkspaceLocal,
  defaultWorkspaceRoot,
  excludeWorktreeDir,
  inspectWorkspaceCleanup,
  isManagedWorkspaceWorktree,
  materializeWorkspaceWorktree,
  rematerializeWorkspaceWorktree,
} from '../workspace/local'
import {
  conflictMarkerFiles,
  hasLeftoverConflictMarkers,
  landResumeArgv,
  staleTrunkCheckout,
  staleTrunkPullAction,
} from '../workspace/land'
import { cleanFailedFreshAttachDir, finishedWorkspaceMessage } from '../workspace/attach'
import { overlapsWith, workspaceSyncRelation } from '../workspace/analysis'
import {
  dropRemoteTolerant,
  isWorkspaceTipPublished,
  workspaceUnsyncedRefusal,
} from '../workspace/drop'
import { ApiError } from '../../lib/api'
import { executableAction } from '../../lib/output'
import * as appContext from '../../lib/app-context'
import * as authModule from '../../auth'
import * as appTargetModule from '../../lib/app-target'
import * as repoApiModule from '../../lib/repo-api'
import * as vcRemoteModule from '../../lib/vc-remote'
import * as vcPushModule from '../../lib/vc-push'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

// Empty until a test assigns it: six describes in this file never do, and an
// unconditional cleanup there deletes whatever the PREVIOUS test left in
// `repo` — invisible in a full run, but `-t`/`.only` then removes a directory
// the selected test still needs. Cleared after each test so the next one
// cannot inherit a stale path. (A sentinel rather than `undefined`: the ~30
// uses below are all inside tests that DO assign it first, and TypeScript
// cannot narrow a module-level `let` across those calls.)
let repo = ''
const ORIG_CWD = process.cwd()
afterEach(() => {
  vi.restoreAllMocks()
  // Clear the exit code the runtime records, so a refusal-path test cannot
  // poison the vitest worker's own exit code.
  process.exitCode = undefined
  // cleanupWorkspaceLocal chdir's to the main checkout when run from inside a
  // worktree — restore before removing the temp repo.
  process.chdir(ORIG_CWD)
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = ''
})

type RunnableCommand = {
  run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
}

async function runWorkspaceJson(
  commandName: string,
  args: Record<string, unknown>,
): Promise<{ output: Record<string, unknown>; exits: Array<number | undefined> }> {
  const command = (workspace.subCommands as Record<string, CommandDef>)[
    commandName
  ] as RunnableCommand
  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation(() => {})

  // The runtime records the code on process.exitCode instead of calling
  // process.exit (see lib/command.ts); the afterEach above clears it.
  process.exitCode = undefined
  await command.run({ args: { ...args, json: true } })
  expect(logs).toHaveLength(1)
  return {
    output: JSON.parse(logs[0]) as Record<string, unknown>,
    exits: [process.exitCode] as Array<number | undefined>,
  }
}

function initRepo(): string {
  repo = mkdtempSync(join(tmpdir(), 'ds-ws-exclude-'))
  git(repo, ['init', '-q', '-b', 'main'])
  return repo
}

function remoteWorkspaceView(id: string): RemoteWorkspaceView {
  return {
    workspace: {
      id,
      task: `Task ${id}`,
      baseOid: 'a'.repeat(40),
      ref: `refs/deepspace/ws/${id}`,
      status: 'active',
      createdBy: 'actor_1',
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      landedOid: null,
    },
    tipOid: 'b'.repeat(40),
    aheadOfBase: { count: 1, capped: false },
    behindTrunk: { count: 0, capped: false },
  }
}

describe('cleanFailedFreshAttachDir', () => {
  it('removes the new target when only attach-created Git metadata remains', () => {
    repo = mkdtempSync(join(tmpdir(), 'ds-ws-attach-clean-'))
    const target = join(repo, 'target')
    mkdirSync(join(target, '.git', 'objects'), { recursive: true })
    expect(cleanFailedFreshAttachDir(target)).toEqual([])
    expect(existsSync(target)).toBe(false)
  })

  it('preserves the target when a checkout file or concurrent write exists', () => {
    repo = mkdtempSync(join(tmpdir(), 'ds-ws-attach-clean-'))
    const target = join(repo, 'target')
    mkdirSync(join(target, '.git'), { recursive: true })
    writeFileSync(join(target, 'keep.txt'), 'keep\n')
    expect(cleanFailedFreshAttachDir(target).sort()).toEqual(['.git', 'keep.txt'])
    expect(existsSync(join(target, 'keep.txt'))).toBe(true)
  })
})

const readExclude = () => readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')

describe('excludeWorktreeDir', () => {
  it('root-anchors a custom in-repo dir so git status stays clean', () => {
    initRepo()
    mkdirSync(join(repo, 'ws-a'))
    writeFileSync(join(repo, 'ws-a', 'junk.txt'), 'j\n')
    excludeWorktreeDir(repo, join(repo, 'ws-a'))
    expect(readExclude()).toContain('.deepspace/')
    expect(readExclude()).toContain('/ws-a/')
    expect(git(repo, ['status', '--porcelain'])).toBe('')
  })

  it('handles a nested custom dir with the full repo-relative path', () => {
    initRepo()
    mkdirSync(join(repo, 'nested', 'ws-b'), { recursive: true })
    writeFileSync(join(repo, 'nested', 'ws-b', 'junk.txt'), 'j\n')
    excludeWorktreeDir(repo, join(repo, 'nested', 'ws-b'))
    expect(readExclude()).toContain('/nested/ws-b/')
    // The parent stays visible — only the worktree dir is hidden. (-uall:
    // plain porcelain collapses an all-untracked parent to `nested/`.)
    writeFileSync(join(repo, 'nested', 'visible.txt'), 'v\n')
    const status = git(repo, ['status', '--porcelain', '--untracked-files=all'])
    expect(status).toContain('nested/visible.txt')
    expect(status).not.toContain('ws-b')
  })

  it('adds no extra pattern for the default .deepspace location or a dir outside the repo', () => {
    initRepo()
    mkdirSync(join(repo, '.deepspace', 'ws', 'x'), { recursive: true })
    excludeWorktreeDir(repo, join(repo, '.deepspace', 'ws', 'x'))
    const outside = mkdtempSync(join(tmpdir(), 'ds-ws-outside-'))
    try {
      excludeWorktreeDir(repo, outside)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
    // Exactly the one shared pattern — nothing anchored, nothing for outside.
    const lines = readExclude()
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    expect(lines).toEqual(['.deepspace/'])
  })

  it('monorepo (app in a subdir): default location adds no anchored line; custom dirs anchor from the toplevel', () => {
    initRepo()
    const app = join(repo, 'apps', 'web')
    mkdirSync(join(app, '.deepspace', 'ws', 'x'), { recursive: true })
    excludeWorktreeDir(app, join(app, '.deepspace', 'ws', 'x'))
    const lines = () =>
      readExclude()
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    // The unanchored `.deepspace/` pattern already covers the nested default —
    // one line total, not one per workspace.
    expect(lines()).toEqual(['.deepspace/'])
    mkdirSync(join(app, 'ws-c'))
    excludeWorktreeDir(app, join(app, 'ws-c'))
    expect(lines()).toContain('/apps/web/ws-c/')
  })

  it('never excludes the repo root itself, and survives a nonexistent dir', () => {
    initRepo()
    writeFileSync(join(repo, 'keep.txt'), 'k\n')
    excludeWorktreeDir(repo, repo)
    excludeWorktreeDir(repo, join(repo, 'does-not-exist'))
    expect(git(repo, ['status', '--porcelain'])).toContain('keep.txt')
    expect(readExclude()).not.toMatch(/^\/+$/m)
  })
})

describe('hasLeftoverConflictMarkers (land pre-push guard)', () => {
  // `git diff --check HEAD^ HEAD` on a committed-marker merge emits real output.
  const withMarkers = [
    'f.txt:2: leftover conflict marker',
    'f.txt:5: trailing whitespace.',
    '+TRUNK   ',
    'f.txt:6: leftover conflict marker',
  ].join('\n')

  it('flags a merge that committed conflict markers', () => {
    expect(hasLeftoverConflictMarkers(withMarkers)).toBe(true)
  })

  it('does NOT flag on whitespace errors alone (must not block a clean land)', () => {
    expect(hasLeftoverConflictMarkers('f.txt:5: trailing whitespace.\n+TRUNK   ')).toBe(false)
  })

  it('does NOT flag on empty output (a clean merge)', () => {
    expect(hasLeftoverConflictMarkers('')).toBe(false)
  })

  it('names each offending file once, tolerating colons in the path', () => {
    expect(conflictMarkerFiles(withMarkers)).toEqual(['f.txt'])
    expect(
      conflictMarkerFiles('weird:1.txt:3: leftover conflict marker\nf.txt:5: trailing whitespace.'),
    ).toEqual(['weird:1.txt'])
    expect(conflictMarkerFiles('')).toEqual([])
  })
})

describe('landResumeArgv (exit-2 resume preserves the caller’s flags)', () => {
  it('is bare when no flags were given (a ws/<id> branch re-infers the workspace)', () => {
    expect(landResumeArgv({})).toEqual(['deepspace', 'workspace', 'land'])
  })

  it('carries -w so a branch that can’t infer the workspace survives a retry', () => {
    expect(landResumeArgv({ workspace: 'ws_01ABCDEFGHJKMNPQRSTVWXYZ00' })).toEqual([
      'deepspace',
      'workspace',
      'land',
      '-w',
      'ws_01ABCDEFGHJKMNPQRSTVWXYZ00',
    ])
  })

  it('preserves --validate and the cleanup opt-out', () => {
    expect(landResumeArgv({ validate: true })).toEqual([
      'deepspace',
      'workspace',
      'land',
      '--validate',
    ])
    expect(landResumeArgv({ validate: true, 'keep-worktree': true })).toEqual([
      'deepspace',
      'workspace',
      'land',
      '--validate',
      '--keep-worktree',
    ])
  })

  it('reconstructs a full invocation in a stable order (-w, --into, --validate, --keep-worktree)', () => {
    expect(
      landResumeArgv({
        workspace: 'ws_01ABCDEFGHJKMNPQRSTVWXYZ00',
        into: 'main',
        validate: true,
        'keep-worktree': true,
      }),
    ).toEqual([
      'deepspace',
      'workspace',
      'land',
      '-w',
      'ws_01ABCDEFGHJKMNPQRSTVWXYZ00',
      '--into',
      'main',
      '--validate',
      '--keep-worktree',
    ])
  })

  it('trims whitespace and omits empty/false flags', () => {
    expect(landResumeArgv({ workspace: '  ', into: ' release ', validate: false })).toEqual([
      'deepspace',
      'workspace',
      'land',
      '--into',
      'release',
    ])
  })
})

describe('staleTrunkCheckout (the "catch up" line + its pull action after a land)', () => {
  const TRUNK = 'main'

  /** A repo whose trunk is checked out in a LINKED worktree, plus a commit on
   *  trunk that the checkout does not have yet (the post-land shape). */
  function repoWithTrunkWorktree(): { main: string; trunkDir: string; landedOid: string } {
    repo = mkdtempSync(join(tmpdir(), 'ds-stale-trunk-'))
    git(repo, ['init', '-q', '-b', 'scratch'])
    git(repo, ['config', 'user.email', 't@t'])
    git(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'f.txt'), 'x\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'init'])
    git(repo, ['branch', TRUNK])
    const trunkDir = join(realpathSync(repo), 'trunk-checkout')
    git(repo, ['worktree', 'add', '-q', trunkDir, TRUNK])
    // Advance trunk past the checkout, the way a land's trunk push does.
    writeFileSync(join(repo, 'g.txt'), 'y\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'landed'])
    const landedOid = git(repo, ['rev-parse', 'HEAD']).trim()
    return { main: repo, trunkDir, landedOid }
  }

  it('names the worktree holding trunk when it is strictly behind the landed merge', () => {
    const { main, trunkDir, landedOid } = repoWithTrunkWorktree()
    expect(staleTrunkCheckout(main, TRUNK, landedOid)).toBe(trunkDir)
  })

  it('answers null when trunk already has the merge, or is ahead of it', () => {
    const { main, trunkDir, landedOid } = repoWithTrunkWorktree()
    // Up to date: the checkout IS the landed commit — nothing to catch up on.
    git(trunkDir, ['merge', '-q', '--ff-only', landedOid])
    expect(staleTrunkCheckout(main, TRUNK, landedOid)).toBeNull()
    // Ahead: `deepspace pull` fast-forwards, so it would refuse this — no
    // action beats an action that cannot run.
    writeFileSync(join(trunkDir, 'h.txt'), 'z\n')
    git(trunkDir, ['add', '-A'])
    git(trunkDir, ['commit', '-q', '-m', 'local trunk work'])
    expect(staleTrunkCheckout(main, TRUNK, landedOid)).toBeNull()
  })

  it('answers null when trunk has DIVERGED, and when no checkout holds it', () => {
    const { main, trunkDir, landedOid } = repoWithTrunkWorktree()
    writeFileSync(join(trunkDir, 'h.txt'), 'z\n')
    git(trunkDir, ['add', '-A'])
    git(trunkDir, ['commit', '-q', '-m', 'divergent trunk work'])
    expect(staleTrunkCheckout(main, TRUNK, landedOid)).toBeNull()

    git(main, ['worktree', 'remove', '--force', trunkDir])
    expect(staleTrunkCheckout(main, TRUNK, landedOid)).toBeNull()
    // And a branch no worktree ever held.
    expect(staleTrunkCheckout(main, 'no-such-branch', landedOid)).toBeNull()
  })
})

describe('cleanupRefusalMessage (#6 — never advise destructive recovery)', () => {
  it('contains NEITHER --force NOR branch -D, and routes through inspect → preserve → plain remove', () => {
    const msg = cleanupRefusalMessage({
      error: 'git worktree remove /w failed: contains modified or untracked files',
      worktreeDir: '/work/ws-a',
      branch: 'ws/01hcleanup000000000000abcd',
    })
    expect(msg).not.toContain('--force')
    expect(msg).not.toContain('branch -D')
    expect(msg).toContain('/work/ws-a')
    expect(msg).toMatch(/git -C .* status/) // inspect step before any removal
    expect(msg).toContain('git worktree remove') // the plain, non-forcing removal
  })

  it('quotes a worktree path with spaces so the human command stays valid', () => {
    const msg = cleanupRefusalMessage({
      error: 'refused',
      worktreeDir: '/Users/me/My Apps/ws-a',
      branch: 'ws/x',
    })
    expect(msg).toContain("'/Users/me/My Apps/ws-a'")
    expect(msg).not.toContain('--force')
  })

  it('falls back to a branch-only hint when there is no worktree, still non-destructive', () => {
    const msg = cleanupRefusalMessage({ error: 'boom', worktreeDir: null, branch: 'ws/x' })
    expect(msg).not.toContain('--force')
    expect(msg).not.toContain('branch -D')
    expect(msg).toContain("'ws/x'")
  })
})

describe('cleanupWorkspaceLocal (workspace land/drop default cleanup)', () => {
  const ID = 'ws_01hcleanup000000000000abcd'
  const BRANCH = `ws/${ID.slice(3).toLowerCase()}`

  function initRepoWithCommit(): string {
    repo = mkdtempSync(join(tmpdir(), 'ds-ws-cleanup-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@t'])
    git(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
    writeFileSync(join(repo, 'f.txt'), 'x\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'init'])
    return repo
  }

  /** A linked worktree on BRANCH at HEAD, at .deepspace/ws/<id>. */
  function addWorktree(main: string): string {
    const dir = join(main, '.deepspace', 'ws', ID.slice(3).toLowerCase())
    materializeWorkspaceWorktree(main, dir, BRANCH, 'HEAD', ID)
    return dir
  }

  it('removes the linked worktree and its branch, run from the main checkout', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    const res = cleanupWorkspaceLocal(main, ID, 'main')
    expect(res.error).toBeUndefined()
    expect(res.worktreeRemoved).toBeTruthy()
    expect(res.branchDeleted).toBe(BRANCH)
    expect(res.mainDir).toBeUndefined() // not run from inside
    expect(existsSync(dir)).toBe(false)
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toBe('')
  })

  it('prunes a hand-deleted worktree registration before deleting the branch', () => {
    // listWorktrees drops entries whose directory is gone, so a worktree the
    // user deleted by hand never reaches the removal arm — cleanup used to
    // delete the branch and leave git holding a registration for a checkout
    // that does not exist, on a ref that no longer does either.
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    const registrations = () => git(main, ['worktree', 'list', '--porcelain'])
    rmSync(dir, { recursive: true, force: true })
    expect(registrations()).toContain('.deepspace/ws/')

    const res = cleanupWorkspaceLocal(main, ID, 'main')

    expect(res.branchDeleted).toBe(BRANCH)
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toBe('')
    expect(registrations()).not.toContain('.deepspace/ws/')
  })

  it('pins the pull action to the surviving primary checkout before cleanup', () => {
    const main = initRepoWithCommit()
    const workspaceDir = addWorktree(main)
    const makeEntry = (dir: string): string => {
      const packageDir = join(dir, 'node_modules', 'deepspace')
      const entry = join(packageDir, 'dist', 'cli.js')
      mkdirSync(join(packageDir, 'dist'), { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'deepspace' }))
      writeFileSync(entry, '#!/usr/bin/env node\n')
      return entry
    }
    const primaryEntry = makeEntry(main)
    const workspaceEntry = makeEntry(workspaceDir)
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', workspaceEntry])

    // staleTrunkPullAction pins the interpreter at CONSTRUCTION (land calls
    // it before cleanup), and the entry it pins is the SURVIVING primary
    // checkout's install — cleanup deletes the workspace entry this process
    // is running from.
    const action = staleTrunkPullAction(main, 'main')
    expect(action.argv).toEqual([
      process.execPath,
      realpathSync(primaryEntry),
      'pull',
      '-b',
      'main',
    ])

    const cleanup = cleanupWorkspaceLocal(main, ID, 'main')
    expect(cleanup.error).toBeUndefined()
    expect(existsSync(workspaceEntry)).toBe(false)
    expect(existsSync(primaryEntry)).toBe(true)
    expect(executableAction(action)).toEqual(action)
  })

  it('retains the branch when it advances after the caller approved an older tip', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    const approvedTip = git(main, ['rev-parse', BRANCH]).trim()

    writeFileSync(join(dir, 'concurrent.txt'), 'new agent work\n')
    git(dir, ['add', 'concurrent.txt'])
    git(dir, ['commit', '-q', '-m', 'concurrent work'])
    const advancedTip = git(main, ['rev-parse', BRANCH]).trim()

    const res = cleanupWorkspaceLocal(main, ID, 'main', {
      expectedBranchOid: approvedTip,
    })

    expect(res.worktreeRemoved).toBeTruthy()
    expect(res.branchDeleted).toBeNull()
    expect(res.error).toMatch(/advanced.*retained/i)
    expect(git(main, ['rev-parse', BRANCH]).trim()).toBe(advancedTip)
  })

  it('rolls back a just-created checkout when its ownership marker cannot be written', () => {
    const main = initRepoWithCommit()
    const dir = join(main, '.deepspace', 'ws', ID.slice(3).toLowerCase())

    expect(() =>
      materializeWorkspaceWorktree(main, dir, BRANCH, 'HEAD', ID, {
        markManaged: () => false,
      }),
    ).toThrow(/ownership.*rolled back/i)

    expect(existsSync(dir)).toBe(false)
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toBe('')
    expect(git(main, ['worktree', 'list', '--porcelain'])).not.toContain(dir)
  })

  it('does not delete a just-created branch if it advanced before marker rollback', () => {
    const main = initRepoWithCommit()
    const dir = join(main, '.deepspace', 'ws', ID.slice(3).toLowerCase())

    expect(() =>
      materializeWorkspaceWorktree(main, dir, BRANCH, 'HEAD', ID, {
        markManaged: (worktreeRoot) => {
          writeFileSync(join(worktreeRoot, 'advanced.txt'), 'keep\n')
          git(worktreeRoot, ['add', 'advanced.txt'])
          git(worktreeRoot, ['commit', '-q', '-m', 'advanced'])
          return false
        },
      }),
    ).toThrow(/branch .* remains/i)

    expect(existsSync(dir)).toBe(false)
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toContain(BRANCH)
    expect(git(main, ['log', '-1', '--format=%s', BRANCH]).trim()).toBe('advanced')
  })

  it('re-materializes a deleted worktree with the ownership invariants intact', () => {
    const main = initRepoWithCommit()
    const dir = join(main, '.deepspace', 'ws', ID.slice(3).toLowerCase())
    materializeWorkspaceWorktree(main, dir, BRANCH, 'HEAD', ID)
    git(main, ['worktree', 'remove', '--force', dir])

    expect(rematerializeWorkspaceWorktree(main, dir, BRANCH, ID)).toBeNull()
    expect(existsSync(dir)).toBe(true)
    // The marker is what lets land/drop clean this checkout up later — an
    // unmarked re-attach recreates the stranded-worktree dead end.
    expect(isManagedWorkspaceWorktree(dir, ID)).toBe(true)
  })

  it('rolls the re-materialized checkout back — never the branch — when the marker cannot be written', () => {
    const main = initRepoWithCommit()
    const dir = join(main, '.deepspace', 'ws', ID.slice(3).toLowerCase())
    materializeWorkspaceWorktree(main, dir, BRANCH, 'HEAD', ID)
    git(main, ['worktree', 'remove', '--force', dir])
    const tip = git(main, ['rev-parse', BRANCH]).trim()

    const failure = rematerializeWorkspaceWorktree(main, dir, BRANCH, ID, {
      markManaged: () => false,
    })

    expect(failure).toMatch(/ownership/i)
    expect(existsSync(dir)).toBe(false)
    expect(git(main, ['rev-parse', BRANCH]).trim()).toBe(tip)
  })

  it('retains an unmarked worktree owned by Codex, Claude, or plain Git', () => {
    const main = initRepoWithCommit()
    const dir = join(main, '.claude', 'worktrees', 'external')
    git(main, ['worktree', 'add', '-q', '-b', BRANCH, dir])
    expect(isManagedWorkspaceWorktree(dir, ID)).toBe(false)

    const inspection = inspectWorkspaceCleanup(main, ID)
    expect(inspection.checkout).toEqual({ kind: 'external-linked', dir: realpathSync(dir) })
    expect(inspection.willDeleteBranch).toBe(false)

    const res = cleanupWorkspaceLocal(main, ID, 'main')

    expect(res.error).toBeUndefined()
    expect(res.worktreeRemoved).toBeNull()
    expect(res.worktreeRetained).toBe(realpathSync(dir))
    expect(res.branchDeleted).toBeNull()
    expect(existsSync(dir)).toBe(true)
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toContain(BRANCH)
  })

  it('reports a structured error instead of force-removing leftover untracked files', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    writeFileSync(join(dir, 'dist-junk.txt'), 'junk\n') // untracked → plain remove refuses; NO --force retry
    const res = cleanupWorkspaceLocal(main, ID, 'main')
    expect(res.error).toBeTruthy()
    expect(res.worktreeRemoved).toBeNull()
    expect(res.branchDeleted).toBeNull() // bailed before the branch delete
    expect(existsSync(dir)).toBe(true) // uncommitted/untracked work NOT destroyed
    expect(res.worktreeDir).toBeTruthy() // surfaced for the manual --force fallback
  })

  it('chdirs to the main checkout and reports mainDir when run from inside the worktree', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    process.chdir(dir)
    const res = cleanupWorkspaceLocal(dir, ID, 'main') // appDir = the worktree, as findAppDir would return
    expect(res.error).toBeUndefined()
    expect(res.worktreeRemoved).toBeTruthy()
    expect(res.branchDeleted).toBe(BRANCH)
    expect(res.mainDir).toBeTruthy()
    expect(realpathSync(process.cwd())).toBe(realpathSync(res.mainDir!)) // process moved to main
    expect(existsSync(dir)).toBe(false)
  })

  it('switches to trunk then deletes the branch when ws/<id> is checked out in the main tree (no linked worktree)', () => {
    const main = initRepoWithCommit()
    git(main, ['switch', '-q', '-c', BRANCH]) // clone-mode attach: ws branch checked out, no linked worktree
    const res = cleanupWorkspaceLocal(main, ID, 'main')
    expect(res.error).toBeUndefined()
    expect(res.worktreeRemoved).toBeNull()
    expect(res.branchDeleted).toBe(BRANCH)
    expect(git(main, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('main')
    expect(git(main, ['branch', '--list', BRANCH]).trim()).toBe('')
  })

  it('is non-fatal: a worktree that refuses removal reports an error instead of throwing', () => {
    const main = initRepoWithCommit()
    const dir = addWorktree(main)
    git(main, ['worktree', 'lock', dir]) // a locked worktree refuses even a single --force
    const res = cleanupWorkspaceLocal(main, ID, 'main')
    expect(res.error).toBeTruthy()
    expect(res.worktreeRemoved).toBeNull()
    expect(res.branchDeleted).toBeNull() // bailed before the branch delete
    expect(existsSync(dir)).toBe(true) // still there
    git(main, ['worktree', 'unlock', dir]) // let afterEach clean it
  })
})

describe('workspace drop containment predicate', () => {
  function commit(dir: string, name: string, body: string): string {
    writeFileSync(join(dir, name), body)
    git(dir, ['add', name])
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', name])
    return git(dir, ['rev-parse', 'HEAD']).trim()
  }

  it('separates "this seat has read the line" from "this seat holds unpublished work"', () => {
    // The two questions drop must keep apart. Conflating them is what let a
    // peer that had read NOTHING drop freely while a peer one commit behind
    // was refused — protection inversely proportional to what you had seen.
    const dir = initRepo()
    const base = commit(dir, 'a.txt', 'base\n')
    const published = commit(dir, 'b.txt', 'author work\n')

    // Behind: has not read the published tip, but holds nothing of its own.
    expect(workspaceSyncRelation(dir, base, published)).toBe('behind')
    expect(isWorkspaceTipPublished(dir, base, [published])).toBe(true)

    // Ahead: has read it and built on it — safe to abandon, nothing unseen.
    expect(workspaceSyncRelation(dir, published, base)).toBe('ahead')

    // No local copy at all: nothing to compare, which is the WEAKEST
    // position, not the strongest — the caller must treat `unknown` as
    // "cannot prove I have read it".
    expect(workspaceSyncRelation(dir, null, published)).toBe('unknown')
    expect(workspaceSyncRelation(dir, base, 'f'.repeat(40))).toBe('unknown')
  })
})

describe('workspace drop safety', () => {
  const ID = 'ws_01ABCDEFGHJKMNPQRSTVWXYZ00'
  const BRANCH = `ws/${ID.slice(3).toLowerCase()}`
  const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

  it('distinguishes an unpublished descendant from commits contained by a published tip', () => {
    const main = initRepo()
    git(main, ['config', 'user.email', 't@t'])
    git(main, ['config', 'user.name', 't'])
    writeFileSync(join(main, 'f.txt'), 'base\n')
    git(main, ['add', 'f.txt'])
    git(main, ['commit', '-q', '-m', 'base'])
    const base = git(main, ['rev-parse', 'HEAD']).trim()
    git(main, ['switch', '-q', '-c', BRANCH])
    writeFileSync(join(main, 'f.txt'), 'local\n')
    git(main, ['commit', '-q', '-am', 'local'])
    const local = git(main, ['rev-parse', 'HEAD']).trim()

    expect(isWorkspaceTipPublished(main, local, [base])).toBe(false)
    expect(isWorkspaceTipPublished(main, base, [local])).toBe(true)
  })

  it('returns an exit-1 refusal whose recovery action preserves app and workspace targeting', () => {
    const workspaceDir = '/worktrees/safe'
    const refusal = workspaceUnsyncedRefusal({
      appId: APP_ID,
      id: ID,
      branch: BRANCH,
      workspaceDir,
      status: 'active',
    })

    expect(refusal.actionRequired).toBe(false)
    expect(refusal.action).toEqual({
      cwd: workspaceDir,
      argv: ['deepspace', 'workspace', 'sync', '--app', APP_ID, '--workspace', ID],
    })
    expect(refusal.message).toMatch(/then re-run.*workspace drop/i)
  })

  it('names --keep-worktree but emits NO action once the workspace is finished', () => {
    // A FINISHED workspace can never publish again: sync refuses
    // workspace_not_active and points back at drop, so a sync action here
    // ping-pongs the two verbs forever. Nor may --keep-worktree be the
    // action — it still REAPS the cloud workspace, so it is not a safe
    // default step, and retain-vs-discard is the caller's choice.
    const workspaceDir = '/worktrees/leftover'
    for (const status of ['landed', 'dropped'] as const) {
      const refusal = workspaceUnsyncedRefusal({
        appId: APP_ID,
        id: ID,
        branch: BRANCH,
        workspaceDir,
        status,
      })
      expect(refusal.action).toBeUndefined()
      expect(refusal.actionRequired).toBe(false)
      expect(refusal.message).toContain(status)
      expect(refusal.message).toContain('--keep-worktree')
      // The prose must not sell it as lossless.
      expect(refusal.message).toMatch(/drops the cloud workspace/i)
      expect(refusal.message).toMatch(/nothing can publish them now/i)
    }
  })

  it('still answers a finished workspace with no local worktree', () => {
    const refusal = workspaceUnsyncedRefusal({
      appId: APP_ID,
      id: ID,
      branch: BRANCH,
      workspaceDir: null,
      status: 'landed',
    })
    expect(refusal.action).toBeUndefined()
    expect(refusal.message).toContain('--keep-worktree')
  })
})

describe('workspaceSyncRelation', () => {
  function commit(dir: string, name: string, body: string): string {
    writeFileSync(join(dir, name), body)
    git(dir, ['add', name])
    git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', name])
    return git(dir, ['rev-parse', 'HEAD']).trim()
  }

  it('classifies all five relations by ancestry, never by an unsynced flag', () => {
    // The regression: deriving the relation from "is there unpublished
    // work?" made `behind` unreachable — a strictly behind checkout holds
    // nothing unpublished — so a stale checkout rendered as healthy.
    const dir = initRepo()
    const first = commit(dir, 'a.txt', 'one\n')
    const second = commit(dir, 'b.txt', 'two\n')

    expect(workspaceSyncRelation(dir, second, second)).toBe('in_sync')
    expect(workspaceSyncRelation(dir, first, second)).toBe('behind')
    expect(workspaceSyncRelation(dir, second, first)).toBe('ahead')

    // Diverged: a sibling commit off the shared parent.
    git(dir, ['checkout', '-q', '-b', 'other', first])
    const sibling = commit(dir, 'c.txt', 'three\n')
    expect(workspaceSyncRelation(dir, sibling, second)).toBe('diverged')

    // Unknown, never a guess: an oid this repo cannot resolve, and nulls.
    expect(workspaceSyncRelation(dir, second, 'f'.repeat(40))).toBe('unknown')
    expect(workspaceSyncRelation(dir, null, second)).toBe('unknown')
    expect(workspaceSyncRelation(dir, second, null)).toBe('unknown')
    expect(workspaceSyncRelation(null, second, second)).toBe('unknown')
  })
})

describe('dropRemoteTolerant (post-call truth, legacy-slug tolerance)', () => {
  const ID = 'ws_01ABCDEFGHJKMNPQRSTVWXYZ00'
  const view = (status: string) => ({ workspace: { status } }) as never
  const api = (impl: {
    drop?: () => Promise<{ view: never }>
    get?: () => Promise<{ view: never }>
  }) =>
    ({
      dropWorkspace: impl.drop ?? (() => Promise.reject(new Error('unexpected drop'))),
      getWorkspace: impl.get ?? (() => Promise.reject(new Error('unexpected get'))),
    }) as never

  it('reports a real drop only when THIS call transitioned an active workspace', async () => {
    const fresh = await dropRemoteTolerant(
      api({ drop: async () => ({ view: view('dropped') }) }),
      ID,
      'active',
    )
    expect(fresh.remoteDropped).toBe(true)

    const replay = await dropRemoteTolerant(
      api({ drop: async () => ({ view: view('dropped') }) }),
      ID,
      'dropped',
    )
    expect(replay.remoteDropped).toBe(false)
  })

  it('tolerates workspace_not_active when the re-read proves it finished', async () => {
    const out = await dropRemoteTolerant(
      api({
        drop: async () => {
          throw new ApiError('already landed', 409, 'workspace_not_active')
        },
        get: async () => ({ view: view('landed') }),
      }),
      ID,
      'active',
    )
    expect(out.remoteDropped).toBe(false)
    expect((out.view as { workspace: { status: string } }).workspace.status).toBe('landed')
  })

  it('rethrows the original refusal on other codes, an active re-read, or a failed re-read', async () => {
    const boom = new ApiError('nope', 403, 'forbidden')
    await expect(
      dropRemoteTolerant(api({ drop: async () => Promise.reject(boom) }), ID, 'active'),
    ).rejects.toBe(boom)

    const raced = new ApiError('conflict', 409, 'conflict')
    await expect(
      dropRemoteTolerant(
        api({
          drop: async () => Promise.reject(raced),
          get: async () => ({ view: view('active') }),
        }),
        ID,
        'active',
      ),
    ).rejects.toBe(raced)

    await expect(
      dropRemoteTolerant(
        api({
          drop: async () => Promise.reject(raced),
          get: async () => Promise.reject(new Error('offline')),
        }),
        ID,
        'active',
      ),
    ).rejects.toBe(raced)
  })
})

describe('workspace checkout placement', () => {
  it('anchors defaults under the primary checkout when invoked from a linked worktree', () => {
    const main = initRepo()
    writeFileSync(join(main, 'package.json'), '{}\n')
    git(main, ['add', 'package.json'])
    git(main, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
    const linked = join(main, '.codex', 'worktrees', 'probe')
    git(main, ['worktree', 'add', '-q', '--detach', linked, 'HEAD'])
    const id = 'ws_01hplacement0000000000000abc'

    expect(defaultWorkspaceRoot(linked, id)).toBe(
      join(realpathSync(main), '.deepspace', 'ws', id.slice(3).toLowerCase()),
    )
  })

  it('preserves a nested app path inside the whole-repository worktree', () => {
    const main = initRepo()
    const app = join(main, 'apps', 'web')
    mkdirSync(app, { recursive: true })
    const checkout = join(main, '.deepspace', 'ws', 'probe')
    expect(appDirInWorktree(app, checkout)).toBe(join(checkout, 'apps', 'web'))
  })
})

describe('shared workspace command boundary', () => {
  it.each([
    ['new', {}, 'invalid_task'],
    // A flag-shaped task is the next flag swallowed by a bare -t: the old
    // behavior created a real server-side workspace named "--json" while
    // printing prose to a JSON caller (2026-08-28 lifecycle AX BUG-2).
    ['new', { task: '--json' }, 'invalid_task'],
    ['attach', { id: 'bad' }, 'invalid_workspace'],
    ['sync', { workspace: 'bad' }, 'invalid_workspace'],
    ['list', { limit: 'nope' }, 'invalid_limit'],
    ['status', { workspace: 'bad' }, 'invalid_workspace'],
    ['land', { into: '   ' }, 'invalid_branch'],
    ['drop', { id: 'bad' }, 'invalid_workspace'],
  ])(
    '%s emits one standard JSON refusal and exit 1 before network work',
    async (name, args, code) => {
      const result = await runWorkspaceJson(name, args)
      expect(result.output).toMatchObject({
        ok: false,
        code,
        error: expect.any(String),
      })
      expect(result.output).not.toHaveProperty('0')
      expect(result.exits).toEqual([1])
    },
  )
})

/**
 * `workspace drop` reaps the PUBLISHED line, so a seat that cannot prove it
 * has read that line is refused. This is a documented breaking change and the
 * refusal is what keeps a peer from destroying commits it never fetched, so
 * both seats and the explicit waiver are pinned here.
 */
describe('workspace drop — the unread-tip guard', () => {
  const ID = 'ws_01ABCDEFGHJKMNPQRSTVWXYZ00'
  const BRANCH = `ws/${ID.slice(3).toLowerCase()}`
  const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

  /** An active workspace whose published tip is `tipOid`. */
  function activeView(tipOid: string): RemoteWorkspaceView {
    const view = remoteWorkspaceView(ID)
    return { ...view, tipOid, workspace: { ...view.workspace, id: ID } }
  }

  function mockDropService(view: RemoteWorkspaceView) {
    const dropWorkspace = vi.fn().mockResolvedValue({
      view: { ...view, workspace: { ...view.workspace, status: 'dropped' } },
    })
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    vi.spyOn(vcRemoteModule, 'runGitRemote').mockReturnValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
    })
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      getWorkspace: vi.fn().mockResolvedValue({ view }),
      dropWorkspace,
      getRefs: vi.fn().mockResolvedValue({ head: 'refs/heads/main', refs: [] }),
    } as never)
    return { dropWorkspace }
  }

  it('refuses a seat with NO checkout — seeing nothing is the weakest position', async () => {
    // `cd /tmp && drop <id>` used to be a complete bypass: the protection was
    // inversely proportional to how much the caller had seen.
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(null)
    const { dropWorkspace } = mockDropService(activeView('c'.repeat(40)))

    const { output, exits } = await runWorkspaceJson('drop', { id: ID, app: APP_ID })

    expect(output).toMatchObject({
      ok: false,
      code: 'workspace_behind',
      workspaceId: ID,
      publishedTip: 'c'.repeat(40),
      localTip: null,
      relation: 'unknown',
    })
    expect(String(output.error)).toContain('--abandon-unseen')
    expect(dropWorkspace).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })

  it('refuses IN a checkout that does not hold the published tip locally', async () => {
    repo = mkdtempSync(join(tmpdir(), 'ds-ws-drop-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@t'])
    git(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    git(repo, ['switch', '-q', '-c', BRANCH])
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    // A published tip this clone has never fetched.
    const { dropWorkspace } = mockDropService(activeView('d'.repeat(40)))

    const { output, exits } = await runWorkspaceJson('drop', { id: ID, app: APP_ID })

    expect(output).toMatchObject({ ok: false, code: 'workspace_behind' })
    expect(dropWorkspace).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })

  it('--abandon-unseen proceeds and REPORTS the tip it discarded', async () => {
    // The waiver is a decision, not a silent one: the abandoned oid is the
    // fact whoever wrote it needs, and its ref is retained briefly.
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(null)
    const { dropWorkspace } = mockDropService(activeView('e'.repeat(40)))

    const { output, exits } = await runWorkspaceJson('drop', {
      id: ID,
      app: APP_ID,
      'abandon-unseen': true,
    })

    expect(output).toMatchObject({
      ok: true,
      workspaceId: ID,
      remoteDropped: true,
      discardedTip: 'e'.repeat(40),
    })
    expect(dropWorkspace).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([0])
  })
})

describe('workspace sync — a finished workspace routes to drop', () => {
  const ID = 'ws_01ABCDEFGHJKMNPQRSTVWXYZ00'
  const BRANCH = `ws/${ID.slice(3).toLowerCase()}`
  const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

  it('refuses workspace_not_active and hands back the drop, not "create a new one"', async () => {
    // `sync` on a landed workspace can never publish. Advising a new
    // workspace stranded the checkout; the one verb that resolves a leftover
    // is `drop`, so it rides along as the action.
    repo = mkdtempSync(join(tmpdir(), 'ds-ws-sync-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@t'])
    git(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    git(repo, ['switch', '-q', '-c', BRANCH])
    const view = remoteWorkspaceView(ID)
    const landed: RemoteWorkspaceView = {
      ...view,
      tipOid: null,
      workspace: { ...view.workspace, id: ID, status: 'landed', landedOid: 'f'.repeat(40) },
    }
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      getWorkspace: vi.fn().mockResolvedValue({ view: landed }),
      getRefs: vi.fn().mockResolvedValue({ head: 'refs/heads/main', refs: [] }),
    } as never)

    const { output, exits } = await runWorkspaceJson('sync', { workspace: ID, app: APP_ID })

    expect(output).toMatchObject({
      ok: false,
      code: 'workspace_not_active',
      status: 'landed',
      action: { argv: ['deepspace', 'workspace', 'drop', ID, '--app', APP_ID] },
    })
    expect(String(output.error)).not.toContain('create a new workspace')
    expect(exits).toEqual([1])
  })
})

describe('workspace list — one API call, no local git work', () => {
  const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

  it('emits { workspaces, truncated } without overlaps and touches neither the remote nor local git', async () => {
    // The point of dropping the overlap report: list answers from the repo
    // API alone. A regression re-introducing git work here trips the spies.
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
    const ensureSpaceRemote = vi
      .spyOn(vcRemoteModule, 'ensureSpaceRemote')
      .mockReturnValue('https://example.invalid/repo')
    const runGitRemote = vi.spyOn(vcRemoteModule, 'runGitRemote').mockReturnValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
    })
    const listWorkspaces = vi
      .fn()
      .mockResolvedValue({ views: [remoteWorkspaceView('ws_01ABCDEFGHJKMNPQRSTVWXYZ00')] })
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({ listWorkspaces } as never)

    const { output, exits } = await runWorkspaceJson('list', { app: APP_ID })

    expect(output).toMatchObject({ ok: true, truncated: false })
    const workspaces = output.workspaces as Array<Record<string, unknown>>
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).not.toHaveProperty('overlaps')
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
    expect(ensureSpaceRemote).not.toHaveBeenCalled()
    expect(runGitRemote).not.toHaveBeenCalled()
    expect(exits).toEqual([0])
  })
})

describe('workspace status — fetches a published tip it does not hold', () => {
  const ID = 'ws_01ABCDEFGHJKMNPQRSTVWXYZ00'
  const BRANCH = `ws/${ID.slice(3).toLowerCase()}`
  const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

  it('runs a --refmap= fetch so the relation is computable, without moving tracking refs', async () => {
    // The published object is routinely absent in exactly the checkout that
    // needs the answer (a peer that never fetched what the author synced).
    // Without it a strictly BEHIND checkout reported "you hold unpublished
    // work" about work it does not have. `--refmap=` is what keeps this
    // diagnostic read from advancing any tracking ref.
    repo = mkdtempSync(join(tmpdir(), 'ds-ws-status-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@t'])
    git(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    git(repo, ['switch', '-q', '-c', BRANCH])
    const view = remoteWorkspaceView(ID)
    const absentTip = 'd'.repeat(40)
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    const runGitRemote = vi.spyOn(vcRemoteModule, 'runGitRemote').mockReturnValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
    })
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      getWorkspace: vi.fn().mockResolvedValue({
        view: { ...view, tipOid: absentTip, workspace: { ...view.workspace, id: ID } },
      }),
      getRefs: vi.fn().mockResolvedValue({ head: 'refs/heads/main', refs: [] }),
      listWorkspaces: vi.fn().mockResolvedValue({ views: [], truncated: false }),
    } as never)

    await runWorkspaceJson('status', { workspace: ID, app: APP_ID })

    const fetches = runGitRemote.mock.calls.map(([, , args]) => args)
    const probe = fetches.find(
      (args) => args.includes('--refmap=') && args.includes(view.workspace.ref),
    )
    expect(probe).toBeDefined()
    // The whole point of `--refmap=`: a diagnostic read must not advance any
    // tracking ref behind the user's back.
    expect(probe).toContain('--quiet')
  })
})

describe('pushWorkspaceRef — a behind checkout is not a divergence', () => {
  it('says "just behind" when the published tip CONTAINS this head', async () => {
    // Telling a checkout that holds nothing unpublished "the push was refused
    // rather than drop that work" sends it hunting for work it does not have.
    // Reachable only because the callers pass `publishedTip`.
    repo = mkdtempSync(join(tmpdir(), 'ds-ws-pushref-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@t'])
    git(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'base'])
    const headOid = git(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'f.txt'), 'ahead\n')
    git(repo, ['commit', '-q', '-am', 'ahead'])
    const publishedTip = git(repo, ['rev-parse', 'HEAD']).trim()

    vi.spyOn(vcPushModule, 'pushToSpace').mockReturnValue({
      status: 'non_fast_forward',
      localRef: 'HEAD',
      remoteRef: 'refs/deepspace/ws/x',
      summary: '[rejected] (non-fast-forward)',
      reason: 'non-fast-forward',
    })

    const refusal = await import('../workspace/runtime').then((m) => {
      try {
        m.pushWorkspaceRef(repo, 'token', 'refs/deepspace/ws/x', headOid, publishedTip)
        return null
      } catch (err) {
        return err as { message: string; code: string }
      }
    })

    expect(refusal?.code).toBe('non_fast_forward')
    expect(refusal?.message).toContain('nothing of yours is')
    expect(refusal?.message).toContain('just behind')
    // NOT the divergence wording, which would be false here.
    expect(refusal?.message).not.toContain('drop that work')
  })
})

describe('overlapsWith (client-side overlap intersection)', () => {
  const ME = 'ws_01ABCDEFGHJKMNPQRSTVWXYZ00'
  const PEER = 'ws_01ABCDEFGHJKMNPQRSTVWXYZ01'
  const OTHER = 'ws_01ABCDEFGHJKMNPQRSTVWXYZ02'

  const lines = (
    entries: [string, string, string[]][],
  ): Map<string, { task: string; paths: string[] }> =>
    new Map(entries.map(([id, task, paths]) => [id, { task, paths }]))

  it('reports only the shared paths, carrying the peer’s task for the warning', () => {
    const out = overlapsWith(
      ['src/a.ts', 'src/b.ts'],
      lines([[PEER, 'wire RBAC', ['src/b.ts', 'src/c.ts']]]),
      ME,
    )
    expect(out).toEqual([
      { workspaceId: PEER, task: 'wire RBAC', paths: ['src/b.ts'], morePaths: 0 },
    ])
  })

  it('never reports the workspace against itself (the self entry is in the same map)', () => {
    const out = overlapsWith(['src/a.ts'], lines([[ME, 'mine', ['src/a.ts']]]), ME)
    expect(out).toEqual([])
  })

  it('omits a peer that shares nothing, and reports several that do', () => {
    const out = overlapsWith(
      ['src/a.ts'],
      lines([
        [PEER, 'peer', ['src/a.ts']],
        [OTHER, 'other', ['docs/x.md']],
      ]),
      ME,
    )
    expect(out.map((o) => o.workspaceId)).toEqual([PEER])
  })

  it('caps the named paths at 20 and counts the remainder in morePaths', () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`)
    const [overlap] = overlapsWith(many, lines([[PEER, 'peer', many]]), ME)
    expect(overlap.paths).toHaveLength(20)
    expect(overlap.morePaths).toBe(5)
  })

  it('is empty when this line changed nothing (no paths can intersect)', () => {
    expect(overlapsWith([], lines([[PEER, 'peer', ['src/a.ts']]]), ME)).toEqual([])
  })
})

describe('finishedWorkspaceMessage (attach refusal)', () => {
  const ID = 'ws_01ABCDEFGHJKMNPQRSTVWXYZ00'
  const view = (status: 'landed' | 'dropped', landedOid: string | null) =>
    ({
      workspace: {
        id: ID,
        task: 't',
        baseOid: 'b'.repeat(40),
        ref: `refs/deepspace/ws/${ID}`,
        status,
        createdBy: 'u',
        createdAt: '',
        updatedAt: '',
        landedOid,
      },
      tipOid: null,
      aheadOfBase: null,
      behindTrunk: null,
    }) as Parameters<typeof finishedWorkspaceMessage>[1]

  it('points a LANDED workspace at its merge commit — its ref is deleted at land', () => {
    const msg = finishedWorkspaceMessage(ID, view('landed', 'a'.repeat(40)))
    expect(msg).toContain('landed at aaaaaaaaaa')
    // Must NOT send an agent fetching a ref that no longer exists.
    expect(msg).not.toContain('fetch refs/deepspace/ws/')
  })

  it('still offers the retained ref for a DROPPED workspace (retention window)', () => {
    const msg = finishedWorkspaceMessage(ID, view('dropped', null))
    expect(msg).toContain(`fetch refs/deepspace/ws/${ID}`)
  })
})
