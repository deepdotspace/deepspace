import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import source from '../source'
import * as authModule from '../../auth'
import * as appContext from '../../lib/app-context'
import * as appTarget from '../../lib/app-target'
import * as sourceApi from '../../lib/source-api'
import * as sourceControl from '../../lib/source-control'
import * as repoApiModule from '../../lib/repo-api'
import * as vcRemote from '../../lib/vc-remote'
import * as gitProcess from '../../lib/git/process'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.
vi.setConfig({ testTimeout: 30_000 })

const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
let repo: string | undefined

afterEach(() => {
  vi.restoreAllMocks()
  if (repo) rmSync(repo, { recursive: true, force: true })
  repo = undefined
})

function makeRepo(): { dir: string; oid: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ds-source-command-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'app.txt'), 'source\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'source'], { cwd: dir })
  const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim()
  return { dir, oid }
}

async function runSourceJson(provider: 'github' | 'deepspace') {
  const logs: string[] = []
  const exits: number[] = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code ?? 0)
    throw new Error(`exit:${code ?? 0}`)
  }) as never)
  const command = source as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }
  await command.run({ args: { provider, json: true } }).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.startsWith('exit:')) throw error
  })
  return { output: JSON.parse(logs[0]) as Record<string, unknown>, exits }
}

function arrangeGitHubClaim(oid: string | null) {
  vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
  vi.spyOn(appTarget, 'resolveAppTarget').mockResolvedValue(APP_ID)
  vi.spyOn(sourceApi, 'getAppSource').mockResolvedValue({
    appId: APP_ID,
    source: null,
    revision: 0,
    registered: false,
  })
  vi.spyOn(sourceControl, 'selectGitHubRemote').mockReturnValue({
    name: 'origin',
    repository: 'deepspacerepos/source-test',
    url: 'git@github.com:deepspacerepos/source-test.git',
  })
  vi.spyOn(sourceControl, 'remoteBranchOid').mockReturnValue(oid)
}

function arrangeDeepSpaceTransfer(activeWorkspaces: number, oid: string) {
  vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
  vi.spyOn(appTarget, 'resolveAppTarget').mockResolvedValue(APP_ID)
  vi.spyOn(sourceApi, 'getAppSource').mockResolvedValue({
    appId: APP_ID,
    source: { provider: 'deepspace' },
    revision: 2,
    registered: true,
  })
  vi.spyOn(sourceControl, 'selectGitHubRemote').mockReturnValue({
    name: 'origin',
    repository: 'deepspacerepos/source-test',
    url: 'git@github.com:deepspacerepos/source-test.git',
  })
  vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
    listWorkspaces: vi.fn(async () => ({
      views: Array.from({ length: activeWorkspaces }, () => ({})),
    })),
    getRefs: vi.fn(async () => ({
      refs: [{ name: 'refs/heads/main', oid, updatedAt: 'now', updatedBy: 'owner' }],
      head: 'refs/heads/main',
    })),
    latestRelease: vi.fn(async () => ({ release: null })),
  } as never)
}

describe('app source GitHub ownership', () => {
  it('returns the exact manual push and does not claim source when HEAD is unpublished', async () => {
    const made = makeRepo()
    repo = made.dir
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    arrangeGitHubClaim(null)
    const setSource = vi.spyOn(sourceApi, 'setAppSource')

    const { output, exits } = await runSourceJson('github')
    expect(output).toMatchObject({
      ok: false,
      code: 'github_push_required',
      actionRequired: true,
      repository: 'deepspacerepos/source-test',
      branch: 'main',
      oid: made.oid,
      action: { cwd: repo, argv: ['git', 'push', 'origin', 'main'] },
    })
    expect(setSource).not.toHaveBeenCalled()
    expect(exits).toEqual([2])
  })

  it('claims GitHub only after read-only verification finds exact remote HEAD', async () => {
    const made = makeRepo()
    repo = made.dir
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    arrangeGitHubClaim(made.oid)
    const setSource = vi.spyOn(sourceApi, 'setAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 1,
    })

    const { output, exits } = await runSourceJson('github')
    expect(setSource).toHaveBeenCalledWith(expect.any(String), 'token', APP_ID, {
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      expectedRevision: 0,
    })
    expect(output).toMatchObject({
      ok: true,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 1,
    })
    expect(exits).toEqual([0])
  })

  it('refuses an active DeepSpace workspace before fetching or asking for a GitHub push', async () => {
    const made = makeRepo()
    repo = made.dir
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    arrangeDeepSpaceTransfer(1, made.oid)
    const fetch = vi.spyOn(vcRemote, 'runGitRemote')
    const setSource = vi.spyOn(sourceApi, 'setAppSource')

    const { output, exits } = await runSourceJson('github')
    expect(output).toMatchObject({ ok: false, code: 'active_workspaces' })
    expect(fetch).not.toHaveBeenCalled()
    expect(setSource).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })

  it('flips DeepSpace to GitHub only after the full public ref set is verified', async () => {
    const made = makeRepo()
    repo = made.dir
    execFileSync('git', ['update-ref', 'refs/deepspace/source-transfer/heads/main', made.oid], {
      cwd: repo,
    })
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    arrangeDeepSpaceTransfer(0, made.oid)
    vi.spyOn(vcRemote, 'ensureSpaceRemote').mockReturnValue('https://deploy.test/repo')
    vi.spyOn(vcRemote, 'runGitRemote').mockReturnValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
    })
    vi.spyOn(sourceControl, 'remotePublicRefs').mockReturnValue([
      { name: 'refs/heads/main', oid: made.oid },
    ])
    const setSource = vi.spyOn(sourceApi, 'setAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 3,
    })

    const { output, exits } = await runSourceJson('github')
    expect(setSource).toHaveBeenCalledWith(expect.any(String), 'token', APP_ID, {
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      expectedRevision: 2,
      refs: [{ name: 'refs/heads/main', oid: made.oid }],
      expectedReleaseId: null,
      expectedReleaseCommitOid: null,
    })
    expect(output).toMatchObject({ ok: true, revision: 3 })
    expect(exits).toEqual([0])
  })

  it('mirrors and prunes GitHub public refs before flipping back to DeepSpace', async () => {
    const made = makeRepo()
    repo = made.dir
    execFileSync('git', ['update-ref', 'refs/deepspace/source-transfer/heads/main', made.oid], {
      cwd: repo,
    })
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTarget, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(sourceApi, 'getAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 3,
      registered: true,
    })
    vi.spyOn(sourceControl, 'selectGitHubRemote').mockReturnValue({
      name: 'origin',
      repository: 'deepspacerepos/source-test',
      url: 'git@github.com:deepspacerepos/source-test.git',
    })
    vi.spyOn(sourceControl, 'remoteBranchOid').mockReturnValue(made.oid)
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      latestRelease: vi.fn(async () => ({ release: null })),
    } as never)
    vi.spyOn(vcRemote, 'ensureSpaceRemote').mockReturnValue('https://deploy.test/repo')
    const originalRunGit = gitProcess.runGit
    const pushCalls: string[][] = []
    vi.spyOn(gitProcess, 'runGit').mockImplementation((cwd, args, options) => {
      if (args[0] === 'fetch')
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0 }
      if (args[0] === 'push') {
        pushCalls.push(args)
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0 }
      }
      return originalRunGit(cwd, args, options)
    })
    const setSource = vi.spyOn(sourceApi, 'setAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'deepspace' },
      revision: 4,
    })

    const { output, exits } = await runSourceJson('deepspace')
    expect(pushCalls).toEqual([
      [
        'push',
        '--force',
        '--atomic',
        '--prune',
        'space',
        'refs/deepspace/source-transfer/heads/*:refs/heads/*',
        'refs/deepspace/source-transfer/tags/*:refs/tags/*',
      ],
    ])
    expect(setSource).toHaveBeenCalledWith(expect.any(String), 'token', APP_ID, {
      source: { provider: 'deepspace' },
      expectedRevision: 3,
      branch: 'main',
      commitOid: made.oid,
      refs: [{ name: 'refs/heads/main', oid: made.oid }],
      expectedReleaseId: null,
      expectedReleaseCommitOid: null,
    })
    expect(output).toMatchObject({ ok: true, revision: 4 })
    expect(exits).toEqual([0])
  })
})
