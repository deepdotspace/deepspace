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
import * as repoApiModule from '../../lib/repo-api'
import * as sourceApiModule from '../../lib/source-api'
import * as vcPushModule from '../../lib/vc-push'
import * as vcRemoteModule from '../../lib/vc-remote'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.


// A valid ws/<ulid> branch (Crockford base32: no I/L/O/U).
const WS_BRANCH = 'ws/01hq9j8k7m6n5p4r3s2t1v0w9x'
const WS_ID = 'ws_01HQ9J8K7M6N5P4R3S2T1V0W9X'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' })

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
  const dir = mkdtempSync(join(tmpdir(), 'ds-push-'))
  git(dir, ['init', '-q', '-b', branch])
  git(dir, ['config', 'user.email', 't@t'])
  git(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'f.txt'), 'initial\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'initial'])
  return dir
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

async function runPushJson(args: Record<string, unknown>, appDir = process.cwd()) {
  const logs: string[] = []
  vi.spyOn(appContext, 'findAppDir').mockReturnValue(appDir)
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
  const command = push as unknown as {
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

  it('refuses a MALFORMED ws/ name too — the namespace is reserved by prefix', () => {
    // `ws/fakeid` is not a workspace id, and matching only the ULID shape lets
    // it become a real branch that `land --into` then accepts as a target,
    // stranding the work on it.
    const r = workspaceBranchPushRefusal('ws/fakeid')
    expect(r).not.toBeNull()
    expect(r!.code).toBe('workspace_branch')
    expect(workspaceBranchPushRefusal('wsfoo')).toBeNull()
    expect(workspaceBranchPushRefusal('feature/ws/x')).toBeNull()
    // Case-SENSITIVE, matching the server and git itself: `WS/foo` is a legal
    // branch the server accepts, so refusing it would make the CLI stricter
    // than the platform.
    expect(workspaceBranchPushRefusal('WS/foo')).toBeNull()
    expect(workspaceBranchPushRefusal('ws')).toBeNull()
  })

  it('renders the workspace refusal through the shared exit-2 boundary', async () => {
    repo = makeRepo()
    git(repo, ['switch', '-q', '-c', WS_BRANCH])
    const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId,
      source: { provider: 'deepspace' },
      revision: 1,
      registered: true,
    })

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

describe('unborn scaffold', () => {
  it('sends `no_commits` to `app init` (with the action) while the placeholder is still in wrangler.toml', async () => {
    // The identity preflight is three server round-trips below this point, so
    // the refusal reads the local config: a scaffold whose wrangler.toml still
    // holds `__APP_ID__` is the state `app init` heals, and obeying "commit
    // first" would freeze the placeholder into history.
    repo = mkdtempSync(join(tmpdir(), 'ds-push-unborn-'))
    git(repo, ['init', '-q', '-b', 'main'])
    writeFileSync(join(repo, 'wrangler.toml'), 'name = "x"\n[vars]\nDEEPSPACE_APP_ID = "__APP_ID__"\n')

    const { output, exits } = await runPushJson({}, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'no_commits',
      // Same remedy as deploy's `app_not_initialized`, so the same tier: an
      // agent branching on `actionRequired` (or on exit 2) must not silently
      // drop this case while handling deploy's identical one.
      actionRequired: true,
      action: { cwd: repo, argv: ['deepspace', 'app', 'init'] },
    })
    expect(output.error).toContain('__APP_ID__')
    expect(exits).toEqual([2])
  })

  it('says only "commit first" when wrangler.toml already carries a real id', async () => {
    repo = mkdtempSync(join(tmpdir(), 'ds-push-unborn-'))
    git(repo, ['init', '-q', '-b', 'main'])
    writeFileSync(
      join(repo, 'wrangler.toml'),
      'name = "x"\n[vars]\nDEEPSPACE_APP_ID = "app_01ABCDEFGHJKMNPQRSTVWXYZ00"\n',
    )

    const { output } = await runPushJson({}, repo)

    expect(output).toMatchObject({ ok: false, code: 'no_commits' })
    expect(output.error).not.toContain('__APP_ID__')
    expect(output).not.toHaveProperty('action')
  })
})

describe('GitHub-source preflight', () => {
  it('refuses before git runs and NAMES the repository', async () => {
    const branch = 'main'
    const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
    repo = makeRepo(branch)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId,
      source: { provider: 'github', repository: 'acme/widgets' },
      revision: 3,
      registered: true,
    })
    // The refusal must come from the preflight, not from git's discarded 422.
    const ensureRemote = vi
      .spyOn(vcRemoteModule, 'ensureSpaceRemote')
      .mockReturnValue('https://example.invalid/repo')
    const push = vi.spyOn(vcPushModule, 'pushToSpace')

    const { output, exits } = await runPushJson({ app: 'selected-app', branch }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'source_managed_by_github',
      appId,
      repository: 'acme/widgets',
    })
    expect(output.error).toContain('acme/widgets')
    expect(ensureRemote).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(exits).toEqual([1])
  })
})

describe('the source latch announcement (source fixes at the first release/push)', () => {
  // A committed pack on an unclaimed app means the server latched DeepSpace
  // (the pack POST is the latch; a legacy GitHub-evidence app is refused
  // there instead) — so the CLI states the fact only once the pack actually
  // committed, and never predicts it.
  const stage = () => {
    const branch = 'main'
    const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
    repo = makeRepo(branch)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId,
      source: null,
      revision: 0,
      registered: true,
    })
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      getRefs: vi.fn().mockResolvedValue(null),
    } as never)
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    return { branch, appId }
  }

  it('a committed push on a previously-unclaimed app announces the permanent DeepSpace claim', async () => {
    const { branch } = stage()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(vcPushModule, 'pushToSpace').mockReturnValue({ status: 'committed' } as never)
    await runPushJson({ app: 'selected-app', branch }, repo)
    const notice = stderrSpy.mock.calls.map((call) => String(call[0])).join('')
    expect(notice).toContain('now DeepSpace')
    expect(notice).toContain('permanently')
  })

  it('a rejected push announces nothing — no pack landed, so nothing latched', async () => {
    const { branch } = stage()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(vcPushModule, 'pushToSpace').mockReturnValue({
      status: 'rejected',
      summary: 'rejected',
    } as never)
    await runPushJson({ app: 'selected-app', branch }, repo)
    const notice = stderrSpy.mock.calls.map((call) => String(call[0])).join('')
    expect(notice).not.toContain('now DeepSpace')
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
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId,
      source: { provider: 'deepspace' },
      revision: 1,
      registered: true,
    })
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    // A rejected fast-forward probes the cloud tip (to tell an own-line
    // rewrite and a strictly-behind checkout apart); stub that fetch.
    vi.spyOn(vcRemoteModule, 'runGitRemote').mockReturnValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
    })
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
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId,
      source: { provider: 'deepspace' },
      revision: 1,
      registered: true,
    })
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
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId,
      source: { provider: 'deepspace' },
      revision: 1,
      registered: true,
    })
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    // A rejected fast-forward probes the cloud tip (to tell an own-line
    // rewrite and a strictly-behind checkout apart); stub that fetch.
    vi.spyOn(vcRemoteModule, 'runGitRemote').mockReturnValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
    })
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

describe('the --force ownership ledger', () => {
  const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
  const LEDGER = (branch: string) => `refs/deepspace/pushed/${branch}`

  /** Everything the run needs to reach the push itself, with the network
   *  stubbed: the probe fetch is a no-op, so whatever FETCH_HEAD holds is what
   *  the force guard reads as the cloud tip. */
  function stageTarget() {
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId,
      source: { provider: 'deepspace' },
      revision: 1,
      registered: true,
    })
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    vi.spyOn(vcRemoteModule, 'runGitRemote').mockReturnValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
    })
  }

  const seedFetchHead = (dir: string, oid: string, branch: string) =>
    writeFileSync(join(dir, '.git', 'FETCH_HEAD'), `${oid}\t\tbranch '${branch}' of space\n`)

  // `rev-parse --verify` exits non-zero on a missing ref, which is the answer
  // here rather than a failure.
  const hasRef = (dir: string, ref: string): boolean => {
    try {
      return (
        execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
          cwd: dir,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().length > 0
      )
    } catch {
      return false
    }
  }

  // Two full CLI invocations in one scenario (the up_to_date push, then the
  // refused force), so it carries twice the suite's per-test budget — it
  // timed out at 30s under the parallel release gate.
  it('records NOTHING on up_to_date, so a later force onto a peer tip is still refused', { timeout: 60_000 }, async () => {
    // `up_to_date` means the cloud tip equals ours — just as true right after
    // pulling a PEER's commit as after publishing our own. Recording it would
    // claim ownership of work this checkout never published, and the force
    // guard reads that record as "your own line".
    const branch = 'main'
    repo = makeRepo(branch)
    const root = git(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'ours.txt'), 'our work\n')
    git(repo, ['add', 'ours.txt'])
    git(repo, ['commit', '-q', '-m', 'our work'])
    // A real commit off the SAME root: neither side contains the other, which
    // is what makes this a divergence rather than a rewind.
    git(repo, ['switch', '-q', '--detach', root])
    writeFileSync(join(repo, 'peer.txt'), 'peer work\n')
    git(repo, ['add', 'peer.txt'])
    git(repo, ['commit', '-q', '-m', 'peer work'])
    const peerOid = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['update-ref', 'refs/heads/peer', peerOid])
    git(repo, ['switch', '-q', branch])
    stageTarget()

    const upToDate = vi.spyOn(vcPushModule, 'pushToSpace').mockReturnValue({
      status: 'up_to_date',
      localRef: `refs/heads/${branch}`,
      remoteRef: `refs/heads/${branch}`,
      summary: '(up to date)',
    })
    const first = await runPushJson({ app: 'selected-app', branch }, repo)
    expect(first.output).toMatchObject({ ok: true, status: 'up_to_date' })
    // The whole point: no ownership was claimed.
    expect(hasRef(repo, LEDGER(branch))).toBe(false)

    // Now force over the peer's tip. With no ledger the guard cannot call this
    // our own line, so it refuses rather than dropping the peer's commit.
    upToDate.mockRestore()
    seedFetchHead(repo, peerOid, branch)
    const { output, exits } = await runPushJson(
      { app: 'selected-app', branch, force: true },
      repo,
    )

    expect(output).toMatchObject({
      ok: false,
      code: 'diverged',
      appId,
      branch,
      action: { argv: ['deepspace', 'pull', '--app', appId, '--branch', branch] },
    })
    // No record ⇒ no claim about a peer, and no claim that we pushed it: a
    // plain `git push space` publishes without writing the ledger.
    expect(String(output.error)).toContain('no record of publishing it')
    expect(exits).toEqual([2])
  })

  it('refuses a force that would only REWIND as `behind`, not `diverged`', async () => {
    // The cloud tip CONTAINS ours, so the force publishes nothing and drops
    // provable commits — a fast-forward, not a merge, and its own slug.
    const branch = 'main'
    repo = makeRepo(branch)
    writeFileSync(join(repo, 'newer.txt'), 'newer\n')
    git(repo, ['add', 'newer.txt'])
    git(repo, ['commit', '-q', '-m', 'newer'])
    const aheadOid = git(repo, ['rev-parse', 'HEAD']).trim()
    // Keep the object alive, then rewind the branch behind it.
    git(repo, ['update-ref', 'refs/heads/ahead', aheadOid])
    git(repo, ['reset', '-q', '--hard', 'HEAD~1'])
    stageTarget()
    seedFetchHead(repo, aheadOid, branch)

    const { output, exits } = await runPushJson(
      { app: 'selected-app', branch, force: true },
      repo,
    )

    expect(output).toMatchObject({
      ok: false,
      code: 'behind',
      appId,
      branch,
      action: { argv: ['deepspace', 'pull', '--app', appId, '--branch', branch] },
    })
    expect(String(output.error)).toContain('strictly behind')
    expect(String(output.error)).toContain('REWIND')
    expect(exits).toEqual([2])
  })

  it('reports an ORDINARY push that is strictly behind as `behind`, not non_fast_forward', async () => {
    // Same classification the --force guard makes. `non_fast_forward` here
    // tells an agent to reconcile a divergence that does not exist: the pull
    // is a plain fast-forward and there is nothing local to publish.
    const branch = 'main'
    repo = makeRepo(branch)
    writeFileSync(join(repo, 'newer.txt'), 'newer\n')
    git(repo, ['add', 'newer.txt'])
    git(repo, ['commit', '-q', '-m', 'newer'])
    const aheadOid = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['update-ref', 'refs/heads/ahead', aheadOid])
    git(repo, ['reset', '-q', '--hard', 'HEAD~1'])
    stageTarget()
    seedFetchHead(repo, aheadOid, branch)
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
      code: 'behind',
      // The underlying git outcome stays readable in `extra`.
      status: 'non_fast_forward',
      action: { argv: ['deepspace', 'pull', '--app', appId, '--branch', branch] },
    })
    expect(String(output.error)).toContain('already contains everything this checkout has')
    expect(exits).toEqual([2])
  })
})

describe('rejection codes are one classification across the verbs', () => {
  it('maps an oversize reason to push_too_large rather than the catch-all', async () => {
    // `push`, `workspace sync` and `workspace land` all read
    // `classifyRejection`, so a size-capped push reports the same slug
    // whichever verb hit it.
    const branch = 'main'
    const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
    repo = makeRepo(branch)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId,
      source: { provider: 'deepspace' },
      revision: 1,
      registered: true,
    })
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    vi.spyOn(vcPushModule, 'pushToSpace').mockReturnValue({
      status: 'rejected',
      localRef: `refs/heads/${branch}`,
      remoteRef: `refs/heads/${branch}`,
      summary: '[remote rejected]',
      // The server states the machine fact itself: `<code>: <sentence>`, with
      // the token at offset 0. The pusher-chosen path rides in the detail,
      // where it cannot steal a code.
      reason: 'push_too_large: object exceeds the push size limit — assets/video.mp4',
      code: 'push_too_large',
    })

    const { output } = await runPushJson({ app: 'selected-app', branch }, repo)

    expect(output).toMatchObject({ ok: false, code: 'push_too_large', status: 'rejected' })
  })
})

describe('own-line rewrite recovery', () => {
  const appId = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'

  // A non-fast-forward onto the tip THIS checkout last pushed — an amend of
  // one's own published line.
  function stageOwnRewrite(branch: string) {
    repo = makeRepo(branch)
    const headOid = git(repo, ['rev-parse', 'HEAD']).trim()
    // The private "last pushed by me" ledger the guard reads, plus a
    // FETCH_HEAD the (mocked, no-op) probe fetch leaves in place — together
    // they make the cloud tip read back as our own last push, no network.
    git(repo, ['update-ref', `refs/deepspace/pushed/${branch}`, headOid])
    writeFileSync(join(repo, '.git', 'FETCH_HEAD'), `${headOid}\t\tbranch '${branch}' of space\n`)
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    vi.spyOn(appTargetModule, 'resolveAppTarget').mockResolvedValue(appId)
    vi.spyOn(appTargetModule, 'warnIfPhantomApp').mockResolvedValue()
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId,
      source: { provider: 'deepspace' },
      revision: 1,
      registered: true,
    })
    vi.spyOn(vcRemoteModule, 'ensureSpaceRemote').mockReturnValue('https://example.invalid/repo')
    // The own-last-push probe fetch succeeds as a no-op, leaving the
    // FETCH_HEAD seeded above untouched.
    vi.spyOn(vcRemoteModule, 'runGitRemote').mockReturnValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      status: 0,
    })
    vi.spyOn(vcPushModule, 'pushToSpace').mockReturnValue({
      status: 'non_fast_forward',
      localRef: `refs/heads/${branch}`,
      remoteRef: `refs/heads/${branch}`,
      summary: '[rejected] (non-fast-forward)',
      reason: 'non-fast-forward',
    })
  }

  it('offers `push --force`, not the pull, when the cloud tip is our own last push', async () => {
    const branch = 'feature/selected'
    stageOwnRewrite(branch)
    const { output, exits } = await runPushJson({ app: 'selected-app', branch, force: false }, repo)

    expect(output).toMatchObject({
      ok: false,
      code: 'non_fast_forward',
      appId,
      branch,
      action: { argv: ['deepspace', 'push', '--force', '--app', appId, '--branch', branch] },
    })
    expect(String(output.error)).toContain('rewrote your own published')
    expect(exits).toEqual([2])
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

describe('push mid-merge', () => {
  it('refuses merge_in_progress before touching the network (HEAD is the pre-merge commit)', async () => {
    repo = conflictRepo()
    const ensure = vi.spyOn(authModule, 'ensureToken').mockResolvedValue('token')
    const { output, exits } = await runPushJson({}, repo)
    expect(output).toMatchObject({ ok: false, code: 'merge_in_progress' })
    expect(String(output.error)).toMatch(/git merge --continue/)
    expect(String(output.error)).toMatch(/git merge --abort/)
    expect(output.action).toBeUndefined()
    expect(exits).toEqual([1])
    expect(ensure).not.toHaveBeenCalled()
    // Nothing was resolved for the caller: the merge is still theirs to finish.
    expect(execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repo, encoding: 'utf-8' })).toMatch(/^[0-9a-f]{40}/)
  })
})
