/** Repository preconditions, refs, ancestry, diffs, and worktree-local excludes. */

import { vi, afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorCode, InputError } from '../cli-errors'
import { runGit } from '../git/process'
import {
  assertSyncableRepo,
  checkoutHead,
  currentBranch,
  diffNameOnly,
  ensureLocalExclude,
  initRepo,
  isAncestor,
  isWorkTreeClean,
  mergeBase,
  resolveCommit,
  updateRef,
} from '../git/repository'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.

let dir: string
let first: string
let second: string

function git(cwd: string, args: string[]): string {
  return runGit(cwd, args).stdout.toString('utf-8').trim()
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-git-repository-'))
  initRepo(dir, 'main')
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'a.txt'), 'alpha\n')
  writeFileSync(join(dir, 'b.txt'), 'beta\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'first commit'])
  first = git(dir, ['rev-parse', 'HEAD'])
  writeFileSync(join(dir, 'a.txt'), 'alpha v2\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'second commit'])
  second = git(dir, ['rev-parse', 'HEAD'])
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('repository preconditions', () => {
  it('accepts a plain SHA-1 repo and rejects a non-repo directory', () => {
    expect(() => assertSyncableRepo(dir)).not.toThrow()
    const empty = mkdtempSync(join(tmpdir(), 'ds-nonrepo-'))
    try {
      expect(() => assertSyncableRepo(empty)).toThrow(InputError)
      try {
        assertSyncableRepo(empty)
      } catch (error) {
        expect(errorCode(error)).toBe('not_git_repo')
      }
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('reads the branch and resolves refs', () => {
    expect(currentBranch(dir)).toBe('main')
    expect(resolveCommit(dir, 'refs/heads/main')).toBe(second)
    expect(resolveCommit(dir, 'refs/heads/ghost')).toBeNull()
  })
})

describe('refs and ancestry', () => {
  it('answers ancestry', () => {
    expect(isAncestor(dir, first, second)).toBe(true)
    expect(isAncestor(dir, second, first)).toBe(false)
  })

  it('finds fork points and returns null for unrelated histories', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-mergebase-'))
    try {
      initRepo(repo, 'main')
      git(repo, ['config', 'user.email', 't@example.com'])
      git(repo, ['config', 'user.name', 'T'])
      writeFileSync(join(repo, 'a.txt'), 'base\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'base'])
      const base = git(repo, ['rev-parse', 'HEAD'])

      writeFileSync(join(repo, 'main.txt'), 'trunk\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'trunk moves'])
      const trunk = git(repo, ['rev-parse', 'HEAD'])
      git(repo, ['checkout', '-q', '-b', 'ws', base])
      writeFileSync(join(repo, 'ws.txt'), 'ws\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'ws work'])
      expect(mergeBase(repo, git(repo, ['rev-parse', 'HEAD']), trunk)).toBe(base)

      git(repo, ['merge', '-q', '--no-edit', trunk])
      expect(mergeBase(repo, git(repo, ['rev-parse', 'HEAD']), trunk)).toBe(trunk)

      git(repo, ['checkout', '-q', '--orphan', 'lonely'])
      git(repo, ['rm', '-rq', '-f', '.'])
      writeFileSync(join(repo, 'other.txt'), 'other\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'unrelated root'])
      expect(mergeBase(repo, git(repo, ['rev-parse', 'HEAD']), trunk)).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('writes refs and materializes HEAD', () => {
    const cloneDir = mkdtempSync(join(tmpdir(), 'ds-git-clone-'))
    try {
      initRepo(cloneDir, 'main')
      runGit(cloneDir, ['fetch', '--quiet', dir, 'refs/heads/main'])
      updateRef(cloneDir, 'refs/heads/main', second)
      checkoutHead(cloneDir)
      expect(git(cloneDir, ['rev-parse', 'HEAD'])).toBe(second)
      expect(git(cloneDir, ['show', 'HEAD:a.txt'])).toBe('alpha v2')
      expect(isWorkTreeClean(cloneDir)).toBe(true)
    } finally {
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })
})

describe('diffNameOnly', () => {
  it('reports both sides of a committed rename', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-diffnames-'))
    try {
      initRepo(repo, 'main')
      git(repo, ['config', 'user.email', 't@example.com'])
      git(repo, ['config', 'user.name', 'T'])
      writeFileSync(join(repo, 'old.txt'), 'stable content that Git would rename-detect\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'base'])
      const base = resolveCommit(repo, 'HEAD')!
      git(repo, ['mv', 'old.txt', 'new.txt'])
      git(repo, ['commit', '-q', '-m', 'rename'])
      const head = resolveCommit(repo, 'HEAD')!
      expect(diffNameOnly(repo, base, head).sort()).toEqual(['new.txt', 'old.txt'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('ensureLocalExclude', () => {
  it('uses the common exclude from roots, subdirectories, and linked worktrees', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-exclude-test-'))
    try {
      initRepo(repo, 'main')
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test'])
      writeFileSync(join(repo, 'f.txt'), 'x\n')
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'root'])

      const excludePath = join(repo, '.git', 'info', 'exclude')
      const readExclude = () => readFileSync(excludePath, 'utf-8')
      ensureLocalExclude(repo, '.deepspace/')
      expect(readExclude()).toContain('.deepspace/')

      mkdirSync(join(repo, '.deepspace', 'ws', 'x'), { recursive: true })
      writeFileSync(join(repo, '.deepspace', 'ws', 'x', 'junk.txt'), 'j\n')
      expect(git(repo, ['status', '--porcelain'])).toBe('')

      const before = readExclude()
      ensureLocalExclude(repo, '.deepspace/')
      expect(readExclude()).toBe(before)

      mkdirSync(join(repo, 'sub'))
      ensureLocalExclude(join(repo, 'sub'), 'sub-pattern/')
      expect(readExclude()).toContain('sub-pattern/')

      const worktree = join(repo, 'wt')
      git(repo, ['worktree', 'add', '--quiet', '-b', 'wt-branch', worktree, 'HEAD'])
      ensureLocalExclude(worktree, 'wt-pattern/')
      expect(readExclude()).toContain('wt-pattern/')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
