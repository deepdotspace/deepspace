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
} from '../workspace/local'
import { hasLeftoverConflictMarkers, landResumeArgv } from '../workspace/land'
import { cleanFailedFreshAttachDir, finishedWorkspaceMessage } from '../workspace/attach'
import { overlapsWith } from '../workspace/analysis'
import { withWorkspaceOverlaps } from '../workspace/list'
import { isWorkspaceTipPublished, workspaceUnsyncedRefusal } from '../workspace/drop'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.
vi.setConfig({ testTimeout: 30_000 })

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

let repo: string
const ORIG_CWD = process.cwd()
afterEach(() => {
  vi.restoreAllMocks()
  // cleanupWorkspaceLocal chdir's to the main checkout when run from inside a
  // worktree — restore before removing the temp repo.
  process.chdir(ORIG_CWD)
  rmSync(repo, { recursive: true, force: true })
})

type RunnableCommand = {
  run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
}

async function runWorkspaceJson(
  commandName: string,
  args: Record<string, unknown>,
): Promise<{ output: Record<string, unknown>; exits: number[] }> {
  const command = (workspace.subCommands as Record<string, CommandDef>)[
    commandName
  ] as RunnableCommand
  const logs: string[] = []
  const exits: number[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0)
    throw new Error(`exit:${code ?? 0}`)
  }) as never)

  await command.run({ args: { ...args, json: true } }).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.startsWith('exit:')) throw error
  })
  expect(logs).toHaveLength(1)
  return { output: JSON.parse(logs[0]) as Record<string, unknown>, exits }
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

describe('withWorkspaceOverlaps', () => {
  it('attaches the same overlap facts to machine-readable workspace output', () => {
    repo = mkdtempSync(join(tmpdir(), 'ds-ws-list-'))
    const views = [remoteWorkspaceView('ws_one'), remoteWorkspaceView('ws_two')]
    const overlap = {
      workspaceId: 'ws_two',
      task: 'Task ws_two',
      paths: ['src/shared.ts'],
      morePaths: 0,
    }

    expect(withWorkspaceOverlaps(views, new Map([['ws_one', [overlap]]]))).toEqual([
      { ...views[0], overlaps: [overlap] },
      { ...views[1], overlaps: [] },
    ])
  })
})

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
    })

    expect(refusal.actionRequired).toBe(false)
    expect(refusal.action).toEqual({
      cwd: workspaceDir,
      argv: ['deepspace', 'workspace', 'sync', '--app', APP_ID, '--workspace', ID],
    })
    expect(refusal.message).toMatch(/then re-run.*workspace drop/i)
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
