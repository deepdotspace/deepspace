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
  // Clear the exit code the runtime records, so a refusal-path test cannot
  // poison the vitest worker's own exit code.
  process.exitCode = undefined
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
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  const command = source as unknown as {
    run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
  }
  // The runtime records the code on process.exitCode instead of calling
  // process.exit (see lib/command.ts); the afterEach above clears it.
  process.exitCode = undefined
  await command.run({ args: { provider, json: true } })
  return {
    output: JSON.parse(logs[0]) as Record<string, unknown>,
    exits: [process.exitCode] as Array<number | undefined>,
  }
}

function arrangeGitHubClaim() {
  vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
  vi.spyOn(appTarget, 'resolveAppTarget').mockResolvedValue(APP_ID)
  vi.spyOn(sourceApi, 'getAppSource').mockResolvedValue({
    appId: APP_ID,
    source: null,
    revision: 0,
    registered: true,
  })
  vi.spyOn(sourceControl, 'selectGitHubRemote').mockReturnValue({
    name: 'origin',
    repository: 'deepspacerepos/source-test',
    url: 'git@github.com:deepspacerepos/source-test.git',
  })
  return vi.spyOn(sourceControl, 'remotePublicRefs').mockReturnValue([])
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
  it('claims GitHub without DeepSpace sync, clean-worktree, or published-HEAD gates', async () => {
    const made = makeRepo()
    repo = made.dir
    writeFileSync(join(repo, 'landing-page.txt'), 'uncommitted deploy bytes\n')
    writeFileSync(join(repo, '.git', 'shallow'), `${made.oid}\n`)
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    const verifyRemote = arrangeGitHubClaim()
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
    expect(verifyRemote).toHaveBeenCalledWith(repo, 'origin')
    expect(output).toMatchObject({
      ok: true,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 1,
    })
    expect(exits).toEqual([0])
  })

  it('does not persist an initial GitHub source when the selected remote is unreachable', async () => {
    const made = makeRepo()
    repo = made.dir
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    arrangeGitHubClaim().mockImplementation(() => {
      throw new gitProcess.GitError('git ls-remote exited 128: repository not found')
    })
    const setSource = vi.spyOn(sourceApi, 'setAppSource')

    const { output, exits } = await runSourceJson('github')

    expect(output).toMatchObject({ ok: false, code: 'git_error' })
    expect(setSource).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })

  it('changes GitHub repositories after one read-only reachability check', async () => {
    const made = makeRepo()
    repo = made.dir
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTarget, 'resolveAppTarget').mockResolvedValue(APP_ID)
    vi.spyOn(sourceApi, 'getAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'github', repository: 'deepspacerepos/old-source' },
      revision: 3,
      registered: true,
    })
    vi.spyOn(sourceControl, 'selectGitHubRemote').mockReturnValue({
      name: 'origin',
      repository: 'deepspacerepos/new-source',
      url: 'git@github.com:deepspacerepos/new-source.git',
    })
    const verifyRemote = vi.spyOn(sourceControl, 'remotePublicRefs').mockReturnValue([])
    const setSource = vi.spyOn(sourceApi, 'setAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'github', repository: 'deepspacerepos/new-source' },
      revision: 4,
    })

    const { output, exits } = await runSourceJson('github')

    expect(verifyRemote).toHaveBeenCalledWith(repo, 'origin')
    expect(setSource).toHaveBeenCalledWith(expect.any(String), 'token', APP_ID, {
      source: { provider: 'github', repository: 'deepspacerepos/new-source' },
      expectedRevision: 3,
    })
    expect(output).toMatchObject({
      ok: true,
      source: { provider: 'github', repository: 'deepspacerepos/new-source' },
      revision: 4,
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

  it('flips DeepSpace to GitHub with local edits after the full public ref set is verified', async () => {
    const made = makeRepo()
    repo = made.dir
    writeFileSync(join(repo, 'app.txt'), 'dirty transfer\n')
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

  it('mirrors GitHub refs from a detached checkout with unpublished local work', async () => {
    const made = makeRepo()
    repo = made.dir
    writeFileSync(join(repo, 'app.txt'), 'unpublished local commit\n')
    execFileSync('git', ['add', 'app.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'local only'], { cwd: repo })
    execFileSync('git', ['checkout', '--detach', '-q'], { cwd: repo })
    writeFileSync(join(repo, 'app.txt'), 'dirty transfer\n')
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
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      latestRelease: vi.fn(async () => ({ release: null })),
    } as never)
    vi.spyOn(sourceControl, 'remotePublicRefs').mockReturnValue([
      { name: 'refs/heads/main', oid: made.oid },
    ])
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
        vcRemote.repoUrl(APP_ID, vcRemote.deployBaseUrl()),
        'refs/deepspace/source-transfer/heads/*:refs/heads/*',
        'refs/deepspace/source-transfer/tags/*:refs/tags/*',
      ],
    ])
    expect(setSource).toHaveBeenCalledWith(expect.any(String), 'token', APP_ID, {
      source: { provider: 'deepspace' },
      expectedRevision: 3,
      refs: [{ name: 'refs/heads/main', oid: made.oid }],
      expectedReleaseId: null,
      expectedReleaseCommitOid: null,
    })
    expect(output).toMatchObject({ ok: true, revision: 4, spaceRemote: 'present' })
    expect(exits).toEqual([0])
  })

  it('refuses to flip when GitHub advances during the import push', async () => {
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
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      latestRelease: vi.fn(async () => ({ release: null })),
    } as never)
    const originalRunGit = gitProcess.runGit
    vi.spyOn(gitProcess, 'runGit').mockImplementation((cwd, args, options) => {
      if (args[0] === 'fetch' || args[0] === 'push') {
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0 }
      }
      return originalRunGit(cwd, args, options)
    })
    vi.spyOn(sourceControl, 'remotePublicRefs').mockReturnValue([
      { name: 'refs/heads/main', oid: 'b'.repeat(40) },
    ])
    const setSource = vi.spyOn(sourceApi, 'setAppSource')

    const { output, exits } = await runSourceJson('deepspace')

    expect(output).toMatchObject({ ok: false, code: 'source_changed' })
    expect(setSource).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })
})

describe('the `space` remote follows source authority', () => {
  it('removes a pre-existing `space` remote when authority moves to GitHub', async () => {
    // 0.23.2 stopped `pull` from CREATING the remote, but one written before
    // the flip (an unclaimed-app pull, or a DeepSpace-era `deepspace clone`)
    // survived it — and `git push space` through it still reached the deploy
    // worker's bodiless 422, walking around `push`'s own preflight.
    const made = makeRepo()
    repo = made.dir
    execFileSync('git', ['remote', 'add', 'space', 'https://deploy.test/api/repo/' + APP_ID], {
      cwd: repo,
    })
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    arrangeGitHubClaim()
    vi.spyOn(sourceApi, 'setAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 1,
    })

    const { output, exits } = await runSourceJson('github')

    expect(output).toMatchObject({ ok: true, spaceRemote: 'removed' })
    expect(
      execFileSync('git', ['remote'], { cwd: repo, encoding: 'utf-8' }).split('\n'),
    ).not.toContain('space')
    expect(exits).toEqual([0])
  })

  it('reports `absent` when a GitHub flip finds no `space` remote to remove', async () => {
    const made = makeRepo()
    repo = made.dir
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    arrangeGitHubClaim()
    vi.spyOn(sourceApi, 'setAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 1,
    })

    const { output, exits } = await runSourceJson('github')

    expect(output).toMatchObject({ ok: true, spaceRemote: 'absent' })
    expect(exits).toEqual([0])
  })

  it('keeps the successful authority result when local remote cleanup fails', async () => {
    const made = makeRepo()
    repo = made.dir
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    arrangeGitHubClaim()
    vi.spyOn(sourceApi, 'setAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 1,
    })
    vi.spyOn(vcRemote, 'removeSpaceRemote').mockImplementation(() => {
      throw new gitProcess.GitError('git remote remove space exited 1: config is locked')
    })

    const { output, exits } = await runSourceJson('github')

    expect(output).toMatchObject({
      ok: true,
      source: { provider: 'github', repository: 'deepspacerepos/source-test' },
      revision: 1,
      spaceRemote: 'repair_required',
      localReconciliation: {
        required: true,
        code: 'git_remote_reconciliation_failed',
      },
    })
    expect(exits).toEqual([0])
  })

  it('does not add the DeepSpace remote when the source flip fails', async () => {
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
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      latestRelease: vi.fn(async () => ({ release: null })),
    } as never)
    const originalRunGit = gitProcess.runGit
    vi.spyOn(gitProcess, 'runGit').mockImplementation((cwd, args, options) => {
      if (args[0] === 'fetch' || args[0] === 'push') {
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0 }
      }
      return originalRunGit(cwd, args, options)
    })
    const ensureRemote = vi.spyOn(vcRemote, 'ensureSpaceRemote')
    vi.spyOn(sourceApi, 'setAppSource').mockRejectedValue(new Error('revision conflict'))

    const { output, exits } = await runSourceJson('deepspace')

    expect(output).toMatchObject({ ok: false })
    expect(ensureRemote).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })
})
