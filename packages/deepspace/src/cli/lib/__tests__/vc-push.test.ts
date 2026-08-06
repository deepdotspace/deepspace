/** Push porcelain parsing, real-Git transfer outcomes, and rejection guidance. */

import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGit } from '../git/process'
import { initRepo } from '../git/repository'
import {
  classifyPushTransportFailure,
  isRecoverablePushFailure,
  isThinPackRejection,
  oversizedPushFix,
  parsePushPorcelain,
  pushFailureMessage,
  pushToSpace,
  type PushRefResult,
} from '../vc-push'
import { SPACE_REMOTE } from '../vc-remote'

describe('parsePushPorcelain', () => {
  it('maps every flag and preserves rejection reasons', () => {
    const out = [
      'To https://deploy-worker.deep.space/api/repo/app_x',
      '*\trefs/heads/new:refs/heads/new\t[new branch]',
      ' \trefs/heads/ff:refs/heads/ff\tabc1234..def5678',
      '+\trefs/heads/forced:refs/heads/forced\tabc1234...def5678 (forced update)',
      '=\trefs/heads/same:refs/heads/same\t[up to date]',
      '!\trefs/heads/behind:refs/heads/behind\t[rejected] (non-fast-forward)',
      '!\trefs/heads/raced:refs/heads/raced\t[remote rejected] (stale ref — fetch first)',
      'Done',
    ].join('\n')
    const results = parsePushPorcelain(out)
    expect(results.map((result) => result.status)).toEqual([
      'committed',
      'committed',
      'committed',
      'up_to_date',
      'non_fast_forward',
      'ref_conflict',
    ])
    expect(results[0]).toMatchObject({
      localRef: 'refs/heads/new',
      remoteRef: 'refs/heads/new',
    })
    expect(results[4].reason).toBe('non-fast-forward')
    expect(results[5].reason).toBe('stale ref — fetch first')
  })

  it('ignores headers, trailers, blanks, and other noise', () => {
    expect(parsePushPorcelain('To https://x\nDone\n')).toEqual([])
    expect(parsePushPorcelain('')).toEqual([])
  })

  const line = (flag: string, summary: string) =>
    `${flag}\trefs/heads/main:refs/heads/main\t${summary}`

  it('classifies the server CAS vocabulary separately from hard rejections', () => {
    for (const reason of [
      'stale ref',
      'stale ref — fetch first',
      'no such ref',
      'atomic push failed',
    ]) {
      expect(parsePushPorcelain(line('!', `[remote rejected] (${reason})`))[0].status).toBe(
        'ref_conflict',
      )
    }
    for (const reason of [
      'object exceeds the 20 MiB limit — remove it or use Git LFS',
      'unpacker error',
      'missing necessary objects',
      'funny refname',
      'blob is not a valid branch tip',
      'deletion of the current branch prohibited',
      'Tip abc1234 of refs/heads/main is a tree, not a commit',
      'thin push too heavy — retry with git push --no-thin',
    ]) {
      const result = parsePushPorcelain(line('!', `[remote rejected] (${reason})`))[0]
      expect(result.status, reason).toBe('rejected')
      expect(result.reason, reason).toBe(reason)
    }
  })

  it('classifies a client-side rejection as non-fast-forward', () => {
    expect(parsePushPorcelain(line('!', '[rejected] (non-fast-forward)'))[0].status).toBe(
      'non_fast_forward',
    )
  })
})

describe('pushToSpace against real repositories', () => {
  let repo: string
  let bare: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ds-vcp-'))
    initRepo(repo, 'main')
    runGit(repo, ['config', 'user.email', 'test@example.com'])
    runGit(repo, ['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'a.txt'), 'v1\n')
    runGit(repo, ['add', '-A'])
    runGit(repo, ['commit', '-q', '-m', 'base'])
    bare = mkdtempSync(join(tmpdir(), 'ds-vcp-bare-'))
    runGit(bare, ['init', '--quiet', '--bare', '-b', 'main'])
    runGit(repo, ['remote', 'add', SPACE_REMOTE, bare])
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  })

  it('reports committed, up-to-date, and non-fast-forward outcomes', () => {
    expect(pushToSpace(repo, 'tok', 'refs/heads/main:refs/heads/main').status).toBe('committed')
    expect(pushToSpace(repo, 'tok', 'refs/heads/main:refs/heads/main').status).toBe('up_to_date')
    runGit(repo, ['commit', '-q', '--amend', '-m', 'rewritten'])
    expect(pushToSpace(repo, 'tok', 'refs/heads/main:refs/heads/main').status).toBe(
      'non_fast_forward',
    )
    expect(
      pushToSpace(repo, 'tok', 'refs/heads/main:refs/heads/main', { force: true }).status,
    ).toBe('committed')
  })

  it('preserves a generic server-side rejection reason', () => {
    const hook = join(bare, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho "rejected: object too large" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const result = pushToSpace(repo, 'tok', 'refs/heads/main:refs/heads/main')
    expect(result.status).toBe('rejected')
    expect(result.reason).toContain('pre-receive hook declined')
  })

  it('can push through an isolated staging remote', () => {
    runGit(repo, ['remote', 'add', 'space-staging', bare])
    expect(pushToSpace(repo, 'tok', 'refs/heads/main:refs/heads/main', {
      remote: 'space-staging',
    }).status).toBe('committed')
  })
})

describe('push rejection decisions', () => {
  const rejected = (reason: string): PushRefResult => ({
    status: 'rejected',
    localRef: 'refs/heads/main',
    remoteRef: 'refs/deepspace/ws/ws_X',
    summary: '[remote rejected]',
    reason,
  })

  it('uses the full-pack retry only for the server thin-pack signal', () => {
    expect(
      isThinPackRejection(rejected('thin push too heavy — retry with git push --no-thin')),
    ).toBe(true)
    for (const reason of [
      'object exceeds the 20 MiB limit — remove it or use Git LFS',
      'unpacker error',
      'funny refname',
      'deletion of the current branch prohibited',
    ]) {
      expect(isThinPackRejection(rejected(reason)), reason).toBe(false)
    }
    for (const status of ['committed', 'up_to_date', 'non_fast_forward', 'ref_conflict'] as const) {
      expect(isThinPackRejection({ ...rejected('thin push'), status }), status).toBe(false)
    }
  })

  it('marks only pull-recoverable divergence statuses recoverable', () => {
    expect(isRecoverablePushFailure('non_fast_forward')).toBe(true)
    expect(isRecoverablePushFailure('ref_conflict')).toBe(true)
    expect(isRecoverablePushFailure('rejected')).toBe(false)
    expect(isRecoverablePushFailure('committed')).toBe(false)
    expect(isRecoverablePushFailure('up_to_date')).toBe(false)
  })

  it('keeps transport-only source, quota, and rate-limit refusals distinct', () => {
    expect(
      classifyPushTransportFailure(
        new Error("fatal: unable to access 'https://x/': The requested URL returned error: 409"),
      ),
    ).toMatchObject({ code: 'app_quota_exceeded' })
    expect(
      classifyPushTransportFailure(
        new Error("fatal: unable to access 'https://x/': The requested URL returned error: 422"),
      ),
    ).toMatchObject({
      code: 'source_managed_by_github',
      error: expect.stringContaining('normal Git/GitHub'),
    })
    expect(
      classifyPushTransportFailure(
        new Error("fatal: unable to access 'https://x/': The requested URL returned error: 429"),
      ),
    ).toMatchObject({ code: 'rate_limited' })
  })

  describe('413 (too large)', () => {
    const http413 = new Error('error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413')

    it('names both ceilings', () => {
      const failure = classifyPushTransportFailure(http413)
      expect(failure).toMatchObject({ code: 'push_too_large' })
      expect(failure!.error).toContain('20.0 MiB per file')
      expect(failure!.error).toContain('32.0 MiB of compressed history per push')
    })

    it('does not classify a 413 that is only part of git progress output', () => {
      expect(classifyPushTransportFailure(new Error('Total 413 (delta 3), reused 0'))).toBeNull()
      expect(classifyPushTransportFailure(new Error('Counting objects: 413, done.'))).toBeNull()
    })

    it('matches both stderr shapes git emits for an HTTP status failure', () => {
      // The transport reports a failing status one of two ways depending on
      // where it fails — at the advertisement (`unable to access`) or during
      // the RPC (`RPC failed; HTTP …`). Both must classify, or the advice
      // depends on which half of the push broke.
      for (const stderr of [
        "fatal: unable to access 'https://deploy-worker.deep.space/api/repo/app_x/': The requested URL returned error: 413",
        'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413',
        'send-pack: unexpected disconnect while reading sideband packet\nerror: RPC failed; HTTP 413',
      ]) {
        expect(classifyPushTransportFailure(new Error(stderr)), stderr).toMatchObject({
          code: 'push_too_large',
        })
      }
    })

    it('names the offending object when the repo is at hand', () => {
      const repo = mkdtempSync(join(tmpdir(), 'deepspace-413-'))
      try {
        initRepo(repo, 'main')
        // One blob over the 20 MiB per-object cap, one comfortably under.
        writeFileSync(join(repo, 'huge.bin'), Buffer.alloc(21 * 1024 * 1024, 1))
        writeFileSync(join(repo, 'small.txt'), 'fine')
        runGit(repo, ['add', '-A'])
        runGit(repo, ['commit', '-m', 'add media'])

        const failure = classifyPushTransportFailure(http413, repo)
        expect(failure!.error).toContain('The oversized file is huge.bin (21.0 MiB)')
        // Shell-quoted so the command is copy-pasteable for any path.
        expect(failure!.error).toContain("deepspace app files put 'huge.bin'")
        expect(failure!.error).not.toContain('small.txt')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })

    it('still gives the ceilings when the repo has nothing over the per-file cap', () => {
      const repo = mkdtempSync(join(tmpdir(), 'deepspace-413-'))
      try {
        initRepo(repo, 'main')
        writeFileSync(join(repo, 'small.txt'), 'fine')
        runGit(repo, ['add', '-A'])
        runGit(repo, ['commit', '-m', 'small'])

        // A long history can 413 on the pack cap with no single file over the
        // object cap, so the advice must not depend on naming a blob.
        const failure = classifyPushTransportFailure(http413, repo)
        expect(failure!.error).not.toContain('Over the per-file cap')
        expect(failure!.error).toContain('smaller batches')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })
  })

  describe('oversized correction (advice that actually works)', () => {
    /** Commit `file`, then follow the given recipe, and report whether the
     *  oversized blob is still reachable — i.e. still in the next push. */
    function stillInHistory(recipe: (repo: string) => void): boolean {
      const repo = mkdtempSync(join(tmpdir(), 'ds-oversize-'))
      try {
        initRepo(repo, 'main')
        runGit(repo, ['config', 'user.email', 'test@example.com'])
        runGit(repo, ['config', 'user.name', 'Test'])
        // A base commit to reset onto: the recipes under test all rewind to
        // "the last pushed commit", which needs a parent to exist.
        writeFileSync(join(repo, 'a.txt'), 'keep\n')
        runGit(repo, ['add', '-A'])
        runGit(repo, ['commit', '-q', '-m', 'base'])
        writeFileSync(join(repo, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 1))
        runGit(repo, ['add', '-A'])
        runGit(repo, ['commit', '-q', '-m', 'add big'])
        recipe(repo)
        const listed = runGit(repo, ['rev-list', '--objects', '--all']).stdout.toString('utf-8')
        return listed.includes('big.bin')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }

    // The reason the text below is worded the way it is. `git rm --cached` is
    // a worktree change; the blob stays reachable from the commit that added
    // it, so the identical push is refused again.
    it('confirms `git rm --cached` + re-commit does NOT remove the blob from the push', () => {
      expect(
        stillInHistory((repo) => {
          runGit(repo, ['rm', '--cached', '-q', 'big.bin'])
          writeFileSync(join(repo, '.gitignore'), 'big.bin\n')
          runGit(repo, ['add', '.gitignore'])
          runGit(repo, ['commit', '-q', '-m', 'untrack big'])
        }),
      ).toBe(true)
    })

    // `reset --soft` moves HEAD and nothing else, so the file is still STAGED.
    // This is the exact step the shipped recipe used to omit: without the
    // `git restore --staged`, the follow-up commit re-adds the identical blob.
    it('confirms `reset --soft` + re-commit alone re-adds the blob', () => {
      expect(
        stillInHistory((repo) => {
          writeFileSync(join(repo, '.gitignore'), 'big.bin\n')
          runGit(repo, ['reset', '--soft', 'HEAD~1'])
          runGit(repo, ['add', '.gitignore'])
          runGit(repo, ['commit', '-q', '-m', 're-commit without the file'])
        }),
      ).toBe(true)
    })

    /**
     * Runs the shipped sentence itself, step by step, against a real remote,
     * with NO repair flags: every command is exactly what the text tells a
     * caller to type, and a non-zero exit is recorded rather than smoothed
     * over. `--allow-empty` in an earlier version of this test is precisely
     * what hid the file-only case, where `git commit` legitimately exits 1.
     *
     * Both shapes of the offending commit are covered because they end
     * differently and the text has to describe both:
     *   - mixed:      other changes remain -> commit succeeds, push advances
     *   - file-only:  index matches HEAD   -> "nothing to commit", push is
     *                                         already up to date
     * Either way the end state is the same and is what the assertions check:
     * the remote holds no blob, and the worktree is clean.
     */
    function runShippedRecipe(fileOnlyCommit: boolean): {
      commitFailed: boolean
      remoteHasBlob: boolean
      worktree: string
    } {
      const root = mkdtempSync(join(tmpdir(), 'ds-recipe-'))
      const remote = join(root, 'server.git')
      const repo = join(root, 'work')
      const media = join(root, 'media')
      try {
        runGit(root, ['init', '-q', '--bare', 'server.git'])
        mkdirSync(media)
        mkdirSync(repo)
        initRepo(repo, 'main')
        runGit(repo, ['config', 'user.email', 'test@example.com'])
        runGit(repo, ['config', 'user.name', 'Test'])
        mkdirSync(join(repo, 'public'))
        writeFileSync(join(repo, 'a.txt'), 'keep\n')
        runGit(repo, ['add', '-A'])
        runGit(repo, ['commit', '-q', '-m', 'base'])
        runGit(repo, ['remote', 'add', 'space', remote])
        runGit(repo, ['push', '-q', 'space', 'HEAD:refs/heads/main'])
        const lastPushed = runGit(repo, ['rev-parse', 'HEAD']).stdout.toString('utf-8').trim()

        // The offending commit: media under public/, alone or alongside work.
        writeFileSync(join(repo, 'public', 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 1))
        if (!fileOnlyCommit) writeFileSync(join(repo, 'a.txt'), 'keep\nand more\n')
        runGit(repo, ['add', '-A'])
        runGit(repo, ['commit', '-q', '-m', 'add media'])

        // (1) move it OUT of public/.
        renameSync(join(repo, 'public', 'big.bin'), join(media, 'big.bin'))
        // (2) reset --soft to the last pushed commit, then unstage the file.
        runGit(repo, ['reset', '--soft', lastPushed])
        expect(
          runGit(repo, ['diff', '--cached', '--name-only']).stdout.toString('utf-8'),
        ).toContain('public/big.bin')
        runGit(repo, ['restore', '--staged', 'public/big.bin'])
        // (3) commit what remains, then push. Verbatim — no --allow-empty.
        const commit = runGit(repo, ['commit', '-m', 'drop media'], { allowFail: true })
        runGit(repo, ['push', '-q', 'space', 'HEAD:refs/heads/main'])

        return {
          commitFailed: commit.status !== 0,
          remoteHasBlob: runGit(remote, ['rev-list', '--objects', '--all'])
            .stdout.toString('utf-8')
            .includes('big.bin'),
          worktree: runGit(repo, ['status', '--porcelain']).stdout.toString('utf-8').trim(),
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    it('works verbatim when the commit carried other changes too', () => {
      const result = runShippedRecipe(false)
      expect(result.commitFailed).toBe(false)
      expect(result.remoteHasBlob).toBe(false)
      expect(result.worktree).toBe('')
    })

    /** The case `--allow-empty` used to hide: `git commit` exits 1 and the push
     *  reports "Everything up-to-date", and that is the SUCCESSFUL outcome. */
    it('works verbatim when the commit carried only the file, despite exit 1', () => {
      const result = runShippedRecipe(true)
      expect(result.commitFailed).toBe(true)
      expect(result.remoteHasBlob).toBe(false)
      expect(result.worktree).toBe('')
    })

    it('names every step the recipe depends on, including the empty-commit case', () => {
      const advice = oversizedPushFix()
      expect(advice).toContain('git reset --soft')
      expect(advice).toContain('git restore --staged')
      // .gitignore governs Git, not the deploy bundle — the file has to move.
      expect(advice).toContain('move it OUT of `public/`')
      // Without this, exit 1 + "Everything up-to-date" reads as two failures.
      expect(advice).toContain('nothing to commit')
      expect(advice).toContain('Everything up-to-date')
      expect(advice).toContain('git filter-repo')
      expect(advice).toContain('deepspace app files put')
    })
  })

  it('gives an oversized rejection the correction recipe, never a retry action', () => {
    const message = pushFailureMessage(
      'Workspace upload',
      rejected('object exceeds the 20 MiB limit — remove it or use Git LFS'),
    )
    expect(message).toContain('retrying cannot succeed')
    expect(message).toContain('git rev-list --objects --all')
    expect(message).not.toContain('Retry;')
  })

  it.each([
    'unpacker error',
    'funny refname',
    'committed secret: .env — remove from history or rename',
    'commit is not a valid branch tip',
    'an unrecognized future rejection',
  ])('preserves permanent/unknown reason %j without suggesting a retry loop', (reason) => {
    const message = pushFailureMessage('Workspace upload', rejected(reason))
    expect(message).toContain(reason)
    expect(message).toContain('correct the reported history/ref problem')
    expect(message).not.toContain('Retry;')
  })

  it('recommends retry only for the server-classified finalize race', () => {
    expect(
      pushFailureMessage(
        'Workspace upload',
        rejected('missing necessary objects — retry the push'),
      ),
    ).toContain('Retry;')
  })

  it('names oversized files and sizes when the repository is readable', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-oversized-msg-'))
    try {
      initRepo(repo, 'main')
      runGit(repo, ['config', 'user.email', 'test@example.com'])
      runGit(repo, ['config', 'user.name', 'Test'])
      writeFileSync(join(repo, 'model.bin'), 'z'.repeat(5000))
      writeFileSync(join(repo, 'big.bin'), Buffer.alloc(1_572_864, 0x78))
      runGit(repo, ['add', '-A'])
      runGit(repo, ['commit', '-q', '-m', 'add assets'])
      const named = oversizedPushFix(repo, 1000)
      expect(named.indexOf('big.bin')).toBeLessThan(named.indexOf('model.bin'))
      expect(named).toContain('1.5 MiB')
      expect(named).toContain('5 KiB')
      expect(named).toContain('git restore --staged')
      expect(named).not.toContain('rev-list')
      expect(pushFailureMessage('Workspace upload', rejected('object too large'), repo)).toContain(
        'retrying cannot succeed',
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
