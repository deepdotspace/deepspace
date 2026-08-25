/**
 * Pull's local integration decisions, as pure/exported helpers:
 *   - divergedMergeAdvice: branch-relative merge advice (`git merge` always
 *     merges INTO the checked-out branch).
 *   - workspaceBranchPullRefusal: a ws/<id> branch integrates trunk by MERGE,
 *     never a plain pull.
 *   - worktreeHoldingBranch: pull must not move a branch ref that another linked
 *     worktree has checked out (real-git).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pull, {
  divergedMergeAdvice,
  workspaceBranchPullRefusal,
  worktreeHoldingBranch,
} from '../pull'
import { listWorktrees } from '../../lib/git/repository'
import * as appContext from '../../lib/app-context'
import * as authModule from '../../auth'
import * as appTargetModule from '../../lib/app-target'
import * as repoApiModule from '../../lib/repo-api'
import * as vcRemoteModule from '../../lib/vc-remote'
// The remote NAME is derived from DEEPSPACE_ENV at module load (`space` in
// production, `space-staging` in staging), so asserting the production
// literal fails for anyone with that variable set. Assert what the CLI
// itself resolved.
import { SPACE_REMOTE } from '../../lib/vc-remote'
import type { RemoteRefsResult } from '../../lib/repo-api'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.
vi.setConfig({ testTimeout: 30_000 })


const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

// A valid ws/<ulid> branch (Crockford base32: no I/L/O/U).
const WS_BRANCH = 'ws/01hq9j8k7m6n5p4r3s2t1v0w9x'
const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

let repo: string | undefined
afterEach(() => {
  vi.restoreAllMocks()
  // Clear the exit code the runtime records, so a refusal-path test cannot
  // poison the vitest worker's own exit code.
  process.exitCode = undefined
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = undefined
})

function makeRepo(branch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-pull-'))
  git(dir, ['init', '-q', '-b', branch])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'f.txt'), 'initial\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  return dir
}

function commitObject(cwd: string, parent: string, message: string): string {
  const tree = git(cwd, ['rev-parse', `${parent}^{tree}`]).trim()
  return git(cwd, ['commit-tree', tree, '-p', parent, '-m', message]).trim()
}

function mockPullService(
  remote: RemoteRefsResult | null,
  fetchedRefs: Record<string, string> = {},
): void {
  vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
  vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
  vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
  vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
    getRefs: vi.fn().mockResolvedValue(remote),
  } as never)
  vi.spyOn(vcRemoteModule, 'runGitRemote').mockImplementation((cwd, _token, args) => {
    const refspec = args.at(-1) ?? ''
    const destination = refspec.split(':').at(-1) ?? ''
    const oid = fetchedRefs[destination]
    if (oid) git(cwd, ['update-ref', destination, oid])
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0 }
  })
}

function remoteRefs(branch: string, oid: string, head = 'main'): RemoteRefsResult {
  return {
    head: `refs/heads/${head}`,
    refs: [
      {
        name: `refs/heads/${branch}`,
        oid,
        updatedAt: '2026-08-02T00:00:00.000Z',
        updatedBy: 'tester',
      },
    ],
  }
}

/** A repo stopped inside an unresolved merge: `MERGE_HEAD` present, one path conflicted. */
function conflictRepo(): string {
  const dir = makeRepo()
  git(dir, ['switch', '-q', '-c', 'sideA'])
  writeFileSync(join(dir, 'C.md'), 'A\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'A'])
  git(dir, ['switch', '-q', 'main'])
  git(dir, ['switch', '-q', '-c', 'sideB'])
  writeFileSync(join(dir, 'C.md'), 'B\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'B'])
  try {
    execFileSync('git', ['merge', 'sideA'], { cwd: dir, stdio: 'pipe' })
  } catch {
    // The conflict is the point.
  }
  return dir
}

async function runPullJson(args: Record<string, unknown>, appDir = process.cwd()) {
  const logs: string[] = []
  vi.spyOn(appContext, 'findAppDir').mockReturnValue(appDir)
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  const command = pull as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }

  // The runtime records the code on process.exitCode instead of calling
  // process.exit (see lib/command.ts); the afterEach above clears it.
  process.exitCode = undefined
  await command.run({ args: { ...args, json: true } })
  return {
    output: JSON.parse(logs[0]) as Record<string, unknown>,
    exits: [process.exitCode] as Array<number | undefined>,
  }
}

describe('shared pull command boundary', () => {
  it('renders a pre-network invalid branch as JSON and exit 1', async () => {
    const { output, exits } = await runPullJson({ branch: '   ' })
    expect(output).toMatchObject({ ok: false, code: 'invalid_branch' })
    expect(output).not.toHaveProperty('action')
    expect(exits).toEqual([1])
  })
})

describe('divergedMergeAdvice', () => {
  // The interpolated branch is shell-quoted: a "run this" line is
  // human-facing, and Git allows branch names with $(), ;, &, and spaces.
  it('advises a bare merge when the pulled branch IS checked out', () => {
    expect(divergedMergeAdvice('main', true)).toBe(
      `git merge refs/remotes/${SPACE_REMOTE}/'main'`,
    )
  })

  it('advises checkout-then-merge when the pulled branch has no checkout', () => {
    expect(divergedMergeAdvice('feature', false)).toBe(
      `git checkout 'feature' && git merge refs/remotes/${SPACE_REMOTE}/'feature'`,
    )
  })

  it('shell-quotes a branch name carrying shell metacharacters (no expansion on copy-paste)', () => {
    // A branch name Git accepts but a shell would otherwise expand/mis-parse.
    const nasty = '$(rm -rf ~);drop&'
    expect(divergedMergeAdvice(nasty, true)).toBe(
      `git merge refs/remotes/${SPACE_REMOTE}/'$(rm -rf ~);drop&'`,
    )
    // An embedded single quote is escaped the POSIX way, so the command stays
    // one literal argument.
    expect(divergedMergeAdvice("a'b", false)).toBe(
      `git checkout 'a'\\''b' && git merge refs/remotes/${SPACE_REMOTE}/'a'\\''b'`,
    )
  })
})

describe('workspaceBranchPullRefusal', () => {
  it('returns null for an ordinary branch (no behavior change)', () => {
    expect(workspaceBranchPullRefusal('main', 'main')).toBeNull()
    expect(workspaceBranchPullRefusal(null, 'main')).toBeNull()
  })

  it('refuses a workspace branch and identifies the trunk to fetch and merge', () => {
    const r = workspaceBranchPullRefusal(WS_BRANCH, 'main')
    expect(r).not.toBeNull()
    expect(r!.code).toBe('workspace_branch')
    expect(r!.trunk).toBe('main')
    expect(r!.error).toContain('MERGE')
  })

  it('falls back to main when the trunk name is unknown', () => {
    const r = workspaceBranchPullRefusal(WS_BRANCH, null)
    expect(r!.trunk).toBe('main')
  })
})

describe('worktreeHoldingBranch (pull cross-worktree guard)', () => {
  it('finds a linked worktree holding the branch, and ignores the caller itself', () => {
    repo = makeRepo()
    // A linked worktree with `feature` checked out elsewhere.
    const wtDir = join(repo, 'wt-feature')
    git(repo, ['worktree', 'add', '-q', '-b', 'feature', wtDir])
    const worktrees = listWorktrees(repo)

    // From the MAIN checkout (on main), `feature` is held by the linked worktree.
    const held = worktreeHoldingBranch(worktrees, 'feature', repo)
    expect(held).toBeTruthy()
    expect(realpathSync(held!)).toBe(realpathSync(wtDir))
    // `main` lives only in the main checkout — asking from there finds no OTHER holder.
    expect(worktreeHoldingBranch(worktrees, 'main', repo)).toBeNull()
    // A branch nobody has checked out.
    expect(worktreeHoldingBranch(worktrees, 'ghost', repo)).toBeNull()
  })
})

describe('pull gives a fresh clone an identity before handing back a merge', () => {
  it('sets user.email from the login when the checkout has none', async () => {
    // The diverged recovery is `git merge refs/remotes/space/<branch>`, which
    // WRITES a commit. A clone with no global identity dies on `unable to
    // auto-detect email address` exactly where we told the user to run it, so
    // the token must reach `ensureSpaceRemote` — the identity seam.
    const branch = 'main'
    const dir = mkdtempSync(join(tmpdir(), 'ds-pull-ident-'))
    repo = dir
    git(dir, ['init', '-q', '-b', branch])
    // Deliberately NO user.email/user.name, and no global fallback either.
    writeFileSync(join(dir, 'f.txt'), 'initial\n')
    git(dir, ['-c', 'user.email=seed@t', '-c', 'user.name=seed', 'add', '-A'])
    git(dir, [
      '-c',
      'user.email=seed@t',
      '-c',
      'user.name=seed',
      'commit',
      '-q',
      '-m',
      'initial',
    ])
    // `config --get` exits non-zero when unset, which is the state we want.
    const localEmail = (): string => {
      try {
        return execFileSync('git', ['config', '--local', '--get', 'user.email'], {
          cwd: dir,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      } catch {
        return ''
      }
    }

    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const token = `${b64({ alg: 'none' })}.${b64({ email: 'dev@example.com' })}.sig`
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue(token)
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      getRefs: vi.fn().mockResolvedValue(null),
    } as never)
    // The REAL ensureSpaceRemote runs here — that is the seam under test.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // `ensureGitIdentity` reads `git config user.email` unscoped, so a
    // developer's own GLOBAL identity would satisfy it and this test would
    // pass without the fix. Point git at empty global/system config so the
    // checkout really has no identity, as a fresh CI clone does.
    const priorGlobal = process.env.GIT_CONFIG_GLOBAL
    const priorSystem = process.env.GIT_CONFIG_SYSTEM
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'no-such-gitconfig')
    process.env.GIT_CONFIG_SYSTEM = join(dir, 'no-such-gitconfig')
    try {
      expect(localEmail()).toBe('')
      await runPullJson({ app: 'selected-app', branch }, dir)
      expect(localEmail()).toBe('dev@example.com')
    } finally {
      if (priorGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = priorGlobal
      if (priorSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = priorSystem
    }
  })
})

describe('pull recovery target and checkout', () => {
  it('preserves the resolved app and selected branch when the cloud repo is absent', async () => {
    const branch = 'feature/selected'
    repo = makeRepo(branch)
    mockPullService(null)

    const { output, exits } = await runPullJson({ app: 'selected-app', branch }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'no_cloud_repo',
      action: {
        cwd: repo,
        argv: ['deepspace', 'push', '--app', APP_ID, '--branch', branch],
      },
    })
    expect(exits).toEqual([1])
  })

  it('reruns a fast-forward from the worktree that owns the selected branch', async () => {
    const branch = 'feature/selected'
    repo = makeRepo()
    const worktree = join(repo, 'wt-feature')
    git(repo, ['worktree', 'add', '-q', '-b', branch, worktree])
    writeFileSync(join(worktree, 'local.txt'), 'local\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-q', '-m', 'local'])
    const localOid = git(worktree, ['rev-parse', 'HEAD']).trim()
    const remoteOid = commitObject(repo, localOid, 'remote advance')
    const trackingRef = `refs/remotes/${SPACE_REMOTE}/${branch}`
    mockPullService(remoteRefs(branch, remoteOid), { [trackingRef]: remoteOid })

    const { output, exits } = await runPullJson({ app: 'selected-app', branch }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'branch_in_worktree',
      status: 'fetched_only_worktree',
      appId: APP_ID,
      branch,
      worktreePath: realpathSync(worktree),
      action: {
        cwd: realpathSync(worktree),
        argv: ['deepspace', 'pull', '--app', APP_ID, '--branch', branch],
      },
    })
    expect(exits).toEqual([2])
  })

  it('treats unpushed local work as success, not divergence (no exit-2 loop)', async () => {
    // The commit -> pull -> push loop is the default shape of an agentic edit,
    // and its middle step used to be a trap: local-ahead fell into the
    // divergence bucket, so pull exited 2 with `actionRequired` and handed back
    // `git merge <tracking-ref>` — which answers "Already up to date" and
    // changes nothing. An agent honouring the exit-2 contract re-ran pull
    // forever. Nothing is fetched to integrate here, so this is exit 0.
    repo = makeRepo()
    const baseOid = git(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'local.txt'), 'local\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'unpushed local work'])
    const trackingRef = `refs/remotes/${SPACE_REMOTE}/main`
    // The cloud tip is the ancestor the local branch already contains.
    mockPullService(remoteRefs('main', baseOid), { [trackingRef]: baseOid })

    const { output, exits } = await runPullJson({ app: 'ahead-app', branch: 'main' }, repo)

    expect(output).toMatchObject({
      ok: true,
      status: 'local_ahead',
      appId: APP_ID,
      branch: 'main',
      action: {
        cwd: repo,
        argv: ['deepspace', 'push', '--app', APP_ID, '--branch', 'main'],
      },
    })
    expect(exits).toEqual([0])
    // The failure mode this replaced was a refusal/action that could not
    // change state. The successful action is the actual next operation.
    expect(output).not.toHaveProperty('code')
  })

  it('merges a divergent selected branch in the worktree that owns it', async () => {
    const branch = 'feature/selected'
    repo = makeRepo()
    const baseOid = git(repo, ['rev-parse', 'HEAD']).trim()
    const worktree = join(repo, 'wt-feature')
    git(repo, ['worktree', 'add', '-q', '-b', branch, worktree])
    writeFileSync(join(worktree, 'local.txt'), 'local\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-q', '-m', 'local'])
    const remoteOid = commitObject(repo, baseOid, 'remote divergence')
    const trackingRef = `refs/remotes/${SPACE_REMOTE}/${branch}`
    mockPullService(remoteRefs(branch, remoteOid), { [trackingRef]: remoteOid })

    const { output, exits } = await runPullJson({ app: 'selected-app', branch }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'diverged',
      status: 'fetched_only_diverged',
      appId: APP_ID,
      branch,
      worktreePath: realpathSync(worktree),
      action: {
        cwd: realpathSync(worktree),
        argv: ['git', 'merge', trackingRef],
      },
    })
    expect(exits).toEqual([2])
  })

  it('leaves a divergent selected branch actionless when its owning worktree is dirty', async () => {
    const branch = 'feature/selected'
    repo = makeRepo()
    const baseOid = git(repo, ['rev-parse', 'HEAD']).trim()
    const worktree = join(repo, 'wt-feature')
    git(repo, ['worktree', 'add', '-q', '-b', branch, worktree])
    writeFileSync(join(worktree, 'local.txt'), 'local\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-q', '-m', 'local'])
    writeFileSync(join(worktree, 'uncommitted.txt'), 'keep me\n')
    const remoteOid = commitObject(repo, baseOid, 'remote divergence')
    const trackingRef = `refs/remotes/${SPACE_REMOTE}/${branch}`
    mockPullService(remoteRefs(branch, remoteOid), { [trackingRef]: remoteOid })

    const { output, exits } = await runPullJson({ app: 'selected-app', branch }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'diverged',
      status: 'fetched_only_diverged',
      appId: APP_ID,
      branch,
      worktreePath: realpathSync(worktree),
    })
    expect(output).not.toHaveProperty('action')
    expect(output).not.toHaveProperty('actionRequired')
    expect(output.error).toContain('is dirty')
    expect(exits).toEqual([1])
  })

  it('emits checkout as the prerequisite when no worktree owns a divergent branch', async () => {
    const branch = 'feature/selected'
    repo = makeRepo()
    const baseOid = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['switch', '-q', '-c', branch])
    writeFileSync(join(repo, 'local.txt'), 'local\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'local'])
    git(repo, ['switch', '-q', 'main'])
    const remoteOid = commitObject(repo, baseOid, 'remote divergence')
    const trackingRef = `refs/remotes/${SPACE_REMOTE}/${branch}`
    mockPullService(remoteRefs(branch, remoteOid), { [trackingRef]: remoteOid })

    const { output, exits } = await runPullJson({ app: 'selected-app', branch }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'diverged',
      status: 'fetched_only_diverged',
      appId: APP_ID,
      branch,
      action: { cwd: repo, argv: ['git', 'checkout', branch] },
    })
    expect(output).not.toHaveProperty('worktreePath')
    expect(exits).toEqual([2])
  })

  it('merges trunk in the worktree that owns an explicitly selected workspace branch', async () => {
    repo = makeRepo()
    const trunkOid = git(repo, ['rev-parse', 'HEAD']).trim()
    const worktree = join(repo, 'wt-workspace')
    git(repo, ['worktree', 'add', '-q', '-b', WS_BRANCH, worktree])
    const trackingRef = `refs/remotes/${SPACE_REMOTE}/main`
    mockPullService(remoteRefs('main', trunkOid), { [trackingRef]: trunkOid })

    const { output, exits } = await runPullJson({ app: 'selected-app', branch: WS_BRANCH }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'workspace_branch',
      appId: APP_ID,
      branch: WS_BRANCH,
      worktreePath: realpathSync(worktree),
      action: {
        cwd: realpathSync(worktree),
        argv: ['git', 'merge', trackingRef],
      },
    })
    expect(exits).toEqual([2])
  })

  it('does not offer a workspace merge while its owning worktree is dirty', async () => {
    repo = makeRepo()
    const trunkOid = git(repo, ['rev-parse', 'HEAD']).trim()
    const worktree = join(repo, 'wt-workspace')
    git(repo, ['worktree', 'add', '-q', '-b', WS_BRANCH, worktree])
    writeFileSync(join(worktree, 'uncommitted.txt'), 'keep me\n')
    const trackingRef = `refs/remotes/${SPACE_REMOTE}/main`
    mockPullService(remoteRefs('main', trunkOid), { [trackingRef]: trunkOid })

    const { output, exits } = await runPullJson({ app: 'selected-app', branch: WS_BRANCH }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'workspace_branch',
      appId: APP_ID,
      branch: WS_BRANCH,
      worktreePath: realpathSync(worktree),
    })
    expect(output).not.toHaveProperty('action')
    expect(output).not.toHaveProperty('actionRequired')
    expect(output.error).toContain('is dirty')
    expect(exits).toEqual([1])
  })
})

describe('pull mid-merge', () => {
  it('refuses merge_in_progress — including `--branch main` from a conflicted other branch', async () => {
    repo = conflictRepo()
    const ensure = vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    for (const args of [{}, { branch: 'main' }]) {
      const { output, exits } = await runPullJson(args, repo)
      expect(output).toMatchObject({ ok: false, code: 'merge_in_progress' })
      expect(exits).toEqual([1])
    }
    expect(ensure).not.toHaveBeenCalled()
    expect(execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repo, encoding: 'utf-8' })).toMatch(/^[0-9a-f]{40}/)
  })
})
