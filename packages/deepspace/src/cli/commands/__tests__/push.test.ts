/**
 * `deepspace push`'s pure guards: it refuses a workspace branch (a plain push
 * writes the visible `refs/heads/ws/<id>` and bypasses `workspace sync`'s
 * coordination ref + metadata), and `--force` refuses to orphan a peer's work.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import push, { forcePushOrphansWork, workspaceBranchPushRefusal } from '../push'
import * as appContext from '../../lib/app-context'
import * as authModule from '../../auth'
import * as appTargetModule from '../../lib/app-target'
import * as vcPushModule from '../../lib/vc-push'
import * as vcRemoteModule from '../../lib/vc-remote'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.
vi.setConfig({ testTimeout: 30_000 })

// A valid ws/<ulid> branch (Crockford base32: no I/L/O/U).
const WS_BRANCH = 'ws/01hq9j8k7m6n5p4r3s2t1v0w9x'
const WS_ID = 'ws_01HQ9J8K7M6N5P4R3S2T1V0W9X'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

let repo: string | undefined
afterEach(() => {
  vi.restoreAllMocks()
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = undefined
})

function makeRepo(branch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ds-push-'))
  git(dir, ['init', '-q', '-b', branch])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'f.txt'), 'initial\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  return dir
}

async function runPushJson(args: Record<string, unknown>, appDir = process.cwd()) {
  const logs: string[] = []
  const exits: number[] = []
  vi.spyOn(appContext, 'findAppDir').mockReturnValue(appDir)
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0)
    throw new Error(`exit:${code ?? 0}`)
  }) as never)
  const command = push as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }

  await command.run({ args: { ...args, json: true } }).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.startsWith('exit:')) throw error
  })
  return { output: JSON.parse(logs[0]) as Record<string, unknown>, exits }
}

describe('workspaceBranchPushRefusal', () => {
  it('returns null for an ordinary branch (no behavior change)', () => {
    expect(workspaceBranchPushRefusal('main')).toBeNull()
    expect(workspaceBranchPushRefusal(null)).toBeNull()
  })

  it('refuses a workspace branch and explains `workspace sync`', () => {
    const r = workspaceBranchPushRefusal(WS_BRANCH)
    expect(r).not.toBeNull()
    expect(r!.code).toBe('workspace_branch')
    expect(r!.error).toContain('workspace sync')
  })

  it('renders the workspace refusal through the shared exit-2 boundary', async () => {
    repo = makeRepo()
    git(repo, ['switch', '-q', '-c', WS_BRANCH])
    const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()

    const { output, exits } = await runPushJson({ app: 'selected-app', branch: WS_BRANCH }, repo)
    expect(output).toMatchObject({
      ok: false,
      actionRequired: true,
      code: 'workspace_branch',
      appId,
      branch: WS_BRANCH,
      action: {
        cwd: repo,
        argv: ['deepspace', 'workspace', 'sync', '--app', appId, '--workspace', WS_ID],
      },
    })
    expect(exits).toEqual([2])
  })
})

describe('push recovery target', () => {
  it('preserves the resolved app id and selected branch in a divergence action', async () => {
    const branch = 'feature/selected'
    const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
    repo = makeRepo(branch)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    vi.spyOn(vcPushModule, 'pushToSpace').mockReturnValue({
      status: 'non_fast_forward',
      localRef: `refs/heads/${branch}`,
      remoteRef: `refs/heads/${branch}`,
      summary: '[rejected] (non-fast-forward)',
      reason: 'non-fast-forward',
    })

    const { output, exits } = await runPushJson({ app: 'selected-app', branch, force: false }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'non_fast_forward',
      appId,
      branch,
      action: {
        cwd: repo,
        argv: ['deepspace', 'pull', '--app', appId, '--branch', branch],
      },
    })
    expect(exits).toEqual([2])
  })

  it('keeps an unverifiable force actionless but names the exact pull target', async () => {
    const branch = 'feature/selected'
    const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
    repo = makeRepo(branch)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    vi.spyOn(vcRemoteModule, 'runGitRemote')
      .mockImplementationOnce(() => {
        throw new Error('offline')
      })
      .mockReturnValueOnce({
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('offline'),
        status: 1,
      })

    const { output, exits } = await runPushJson({ app: 'selected-app', branch, force: true }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'force_unverified',
      appId,
      branch,
    })
    expect(output.error).toContain(`deepspace pull --app '${appId}' --branch '${branch}'`)
    expect(output).not.toHaveProperty('action')
    expect(output).not.toHaveProperty('actionRequired')
    expect(exits).toEqual([1])
  })

  it('runs pull recovery in the worktree that owns the selected branch', async () => {
    const branch = 'feature/selected'
    const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
    repo = makeRepo()
    const worktree = join(repo, 'wt-feature')
    git(repo, ['worktree', 'add', '-q', '-b', branch, worktree])
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    vi.spyOn(vcPushModule, 'pushToSpace').mockReturnValue({
      status: 'non_fast_forward',
      localRef: `refs/heads/${branch}`,
      remoteRef: `refs/heads/${branch}`,
      summary: '[rejected] (non-fast-forward)',
      reason: 'non-fast-forward',
    })

    const { output } = await runPushJson({ app: 'selected-app', branch, force: false }, repo)

    expect(output).toMatchObject({
      action: {
        cwd: realpathSync(worktree),
        argv: ['deepspace', 'pull', '--app', appId, '--branch', branch],
      },
    })
  })
})

describe('forcePushOrphansWork (--force lost-update guard)', () => {
  const TIP = 'a'.repeat(40)
  const PEER = 'b'.repeat(40) // a peer's tip, NOT contained in ours
  const BASE = 'c'.repeat(40)

  it('allows a first publish (no remote line yet)', () => {
    expect(forcePushOrphansWork(null, null, TIP, false)).toBe(false)
  })

  it('allows when already up to date (remote tip === our tip)', () => {
    expect(forcePushOrphansWork(BASE, TIP, TIP, true)).toBe(false)
  })

  it('allows a rewrite of our OWN line (remote tip === our last-pushed record)', () => {
    // We pushed BASE, then amended → TIP; no peer advanced it.
    expect(forcePushOrphansWork(BASE, BASE, TIP, false)).toBe(false)
  })

  it('allows a normal advance / after we integrated (our tip already contains theirs)', () => {
    expect(forcePushOrphansWork(BASE, PEER, TIP, true)).toBe(false)
  })

  it('REFUSES when a peer advanced the branch to commits we lack (the lost-update case)', () => {
    expect(forcePushOrphansWork(BASE, PEER, TIP, false)).toBe(true)
  })

  it('REFUSES from a fresh checkout with no push record when the peer tip is unintegrated', () => {
    expect(forcePushOrphansWork(null, PEER, TIP, false)).toBe(true)
  })
})
