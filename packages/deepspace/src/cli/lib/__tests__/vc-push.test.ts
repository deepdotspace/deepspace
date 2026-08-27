/** Push porcelain parsing, real-Git transfer outcomes, and rejection guidance. */

import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGit } from '../git/process'
import { initRepo } from '../git/repository'
import {
  classifyPushTransportFailure,
  classifyRejection,
  isRecoverablePushFailure,
  isThinPackRejection,
  oversizedPushFix,
  parsePushPorcelain,
  parseRefusalCode,
  representativeResult,
  pushFailureMessage,
  pushToSpace,
  type PushRefResult,
} from '../vc-push'
import { SPACE_REMOTE } from '../vc-remote'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.

describe('parsePushPorcelain', () => {
  it('maps every flag and preserves rejection reasons', () => {
    const out = [
      'To https://deploy-worker.deep.space/api/repo/app_x',
      '*\trefs/heads/new:refs/heads/new\t[new branch]',
      ' \trefs/heads/ff:refs/heads/ff\tabc1234..def5678',
      '+\trefs/heads/forced:refs/heads/forced\tabc1234...def5678 (forced update)',
      '=\trefs/heads/same:refs/heads/same\t[up to date]',
      '!\trefs/heads/behind:refs/heads/behind\t[rejected] (non-fast-forward)',
      '!\trefs/heads/raced:refs/heads/raced\t[remote rejected] (stale_ref: the ref moved first)',
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
    expect(results[5].reason).toBe('stale_ref: the ref moved first')
  })

  it('ignores headers, trailers, blanks, and other noise', () => {
    expect(parsePushPorcelain('To https://x\nDone\n')).toEqual([])
    expect(parsePushPorcelain('')).toEqual([])
  })

  const line = (flag: string, summary: string) =>
    `${flag}\trefs/heads/main:refs/heads/main\t${summary}`

  it('reads the CAS race off the server token, not off its prose', () => {
    // `stale_ref` is the one rejection `deepspace pull` deterministically
    // fixes, so it is the one that becomes `ref_conflict`.
    const result = parsePushPorcelain(
      line('!', '[remote rejected] (stale_ref: the ref moved since this push was prepared)'),
    )[0]
    expect(result.status).toBe('ref_conflict')
    expect(result.code).toBe('stale_ref')
  })

  it('keeps every other tagged refusal a hard rejection, token parsed', () => {
    for (const [code, sentence] of [
      ['push_too_large', 'object exceeds the 20 MiB limit'],
      ['repo_full', 'repository is at its size ceiling'],
      ['secret_committed', 'a secret file is in this history — .env'],
      ['unpacker_error', 'the pack could not be unpacked'],
      ['missing_objects', 'missing necessary objects'],
      ['thin_pack', 'thin pack bases could not be resolved'],
      ['funny_refname', 'refusing to create a ref with a funny name'],
      ['internal_ref', 'that ref namespace is reserved'],
      ['workspace_creator', 'not the workspace creator'],
      ['bad_tip', 'not a valid branch tip'],
    ] as const) {
      const result = parsePushPorcelain(
        line('!', `[remote rejected] (${code}: ${sentence})`),
      )[0]
      expect(result.status, code).toBe('rejected')
      expect(result.code, code).toBe(code)
      expect(result.reason, code).toBe(`${code}: ${sentence}`)
    }
  })

  it('leaves an untagged reason unparsed rather than guessing at it', () => {
    // An older worker, or a rejection git itself wrote. No token, no code —
    // and deliberately no prose fallback to invent one.
    for (const reason of [
      'unpacker error',
      'funny refname',
      'some unrecognised server reason',
      'Tip abc1234 of refs/heads/main is a tree, not a commit',
    ]) {
      const result = parsePushPorcelain(line('!', `[remote rejected] (${reason})`))[0]
      expect(result.status, reason).toBe('rejected')
      expect(result.reason, reason).toBe(reason)
      expect(result.code, reason).toBeUndefined()
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
    expect(
      pushToSpace(repo, 'tok', 'refs/heads/main:refs/heads/main', {
        remote: 'space-staging',
      }).status,
    ).toBe('committed')
  })
})

describe('push rejection decisions', () => {
  // Mirrors what parsePushPorcelain builds, including the parsed token, so
  // these cases exercise the same shape the real parser produces.
  const rejected = (reason: string): PushRefResult => ({
    status: 'rejected',
    localRef: 'refs/heads/main',
    remoteRef: 'refs/deepspace/ws/ws_X',
    summary: '[remote rejected]',
    reason,
    ...(parseRefusalCode(reason) ? { code: parseRefusalCode(reason)!.code } : {}),
  })

  it('uses the full-pack retry only for the server thin-pack token', () => {
    expect(isThinPackRejection(rejected('thin_pack: thin pack bases unresolved'))).toBe(true)
    for (const reason of [
      'push_too_large: object exceeds the 20 MiB limit',
      'unpacker_error: the pack could not be unpacked',
      'some untagged reason about a thin pack',
      // A pusher-chosen path echoed INSIDE another refusal's sentence cannot
      // reach offset 0, so it cannot fire a wasteful full re-upload.
      'secret_committed: a secret is in this history — thin_pack: notes.txt',
    ]) {
      expect(isThinPackRejection(rejected(reason)), reason).toBe(false)
    }
    for (const status of ['committed', 'up_to_date', 'non_fast_forward', 'ref_conflict'] as const) {
      expect(
        isThinPackRejection({ ...rejected('thin_pack: unresolved'), status }),
        status,
      ).toBe(false)
    }
  })

  it('marks only pull-recoverable divergence statuses recoverable', () => {
    expect(isRecoverablePushFailure('non_fast_forward')).toBe(true)
    expect(isRecoverablePushFailure('ref_conflict')).toBe(true)
    expect(isRecoverablePushFailure('rejected')).toBe(false)
    expect(isRecoverablePushFailure('committed')).toBe(false)
    expect(isRecoverablePushFailure('up_to_date')).toBe(false)
  })

  it('keeps transport-only quota and rate-limit refusals distinct', () => {
    expect(
      classifyPushTransportFailure(
        new Error("fatal: unable to access 'https://x/': The requested URL returned error: 409"),
      ),
    ).toMatchObject({ code: 'app_quota_exceeded' })
    expect(
      classifyPushTransportFailure(
        new Error("fatal: unable to access 'https://x/': The requested URL returned error: 429"),
      ),
    ).toMatchObject({ code: 'rate_limited' })
  })

  it('classifies the GitHub-source 422 as a last resort, without inventing a repository', () => {
    // Both push paths normally decide this BEFORE git runs (push's getAppSource
    // preflight names the repository; deploy skips the cloud push for GitHub
    // source). This branch only catches an older platform whose /source
    // reports no provider — so it names the state and where to look, never a
    // repository it cannot know.
    const failure = classifyPushTransportFailure(
      new Error("fatal: unable to access 'https://x/': The requested URL returned error: 422"),
    )
    expect(failure?.code).toBe('source_managed_by_github')
    expect(failure?.error).toContain('deepspace app status')
  })

  describe('413 (too large)', () => {
    const http413 = new Error(
      'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413',
    )

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
        runGit(repo, ['config', 'user.email', 'test@example.com'])
        runGit(repo, ['config', 'user.name', 'Test'])
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
        runGit(repo, ['config', 'user.email', 'test@example.com'])
        runGit(repo, ['config', 'user.name', 'Test'])
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
        runGit(root, ['init', '-q', '--bare', '-b', 'main', 'server.git'])
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
      rejected('push_too_large: object exceeds the 20 MiB limit'),
    )
    expect(message).toContain('retrying cannot succeed')
    expect(message).toContain('git rev-list --objects --all')
    expect(message).not.toContain('Retry;')
  })

  it.each([
    'unpacker error',
    'funny refname',
    'commit is not a valid branch tip',
    'an unrecognized future rejection',
    'future_server_code: a condition this CLI version cannot explain',
  ])('preserves permanent/unknown reason %j without suggesting a retry loop', (reason) => {
    const message = pushFailureMessage('Workspace upload', rejected(reason))
    // The human line carries the server's sentence; the machine token, when
    // there is one, belongs to the envelope rather than the prose.
    expect(message).toContain(parseRefusalCode(reason)?.sentence ?? reason)
    expect(message).toContain('correct the reported history/ref problem')
    expect(message).not.toContain('Retry;')
  })

  it('advises a retry only where one can actually help', () => {
    // Retryability is the server's verdict, carried by the token — the CLI no
    // longer decides it by reading a sentence.
    expect(
      pushFailureMessage('Workspace upload', rejected('missing_objects: missing necessary objects')),
    ).toMatch(/Retry/i)
    for (const reason of [
      'push_too_large: object exceeds the 20 MiB limit',
      'repo_full: repository is at its size ceiling',
      'unpacker_error: the pack could not be unpacked',
      // Untagged: the old sentence, which now classifies as the catch-all.
      'missing necessary objects — retry the push',
    ]) {
      expect(pushFailureMessage('Workspace upload', rejected(reason)), reason).not.toMatch(
        /Retry;/,
      )
    }
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
      // The token decides the code, so the oversized recipe is reached by
      // `push_too_large:` and by nothing else.
      expect(
        pushFailureMessage(
          'Workspace upload',
          rejected('push_too_large: object exceeds the 20 MiB limit'),
          repo,
        ),
      ).toContain('retrying cannot succeed')
      // Reasons that merely MENTION size vocabulary — a secret refusal naming
      // an .lfs file, a ref name echoing a migration branch — carry a
      // different token or none, so they cannot reach it.
      for (const reason of [
        'secret_committed: a secret is in this history — .env.lfs',
        'stale_ref: refs/heads/lfs-migration moved first',
        'the file object exceeds the 20 MiB limit.txt is tracked',
      ]) {
        expect(pushFailureMessage('Push', rejected(reason), repo), reason).not.toContain(
          'retrying cannot succeed',
        )
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('an HTTP verdict is never reported as an ambiguous outcome', () => {
  // Real git prints `send-pack: unexpected disconnect while reading sideband
  // packet` for EVERY HTTP status, not only for a dropped connection. Matching
  // on that phrase alone reports a 403 permission denial as "it may have
  // landed", sending an agent to poll a branch it cannot read — and the status
  // is the only diagnostic that survives, since git drops the response body.
  const withStatus = (status: number) =>
    classifyPushTransportFailure(
      new Error(
        `error: RPC failed; HTTP ${status} curl 22 The requested URL returned error: ${status}\n` +
          'send-pack: unexpected disconnect while reading sideband packet\n' +
          'fatal: the remote end hung up unexpectedly',
      ),
    )

  it('names the auth and permission verdicts, which are DEFINITE failures', () => {
    expect(withStatus(401)).toMatchObject({ code: 'not_authenticated' })
    expect(withStatus(401)?.error).toMatch(/nothing was applied/i)
    expect(withStatus(403)).toMatchObject({ code: 'forbidden' })
    expect(withStatus(403)?.error).toMatch(/nothing was applied/i)
  })

  it('never calls a status-carrying failure an unknown outcome', () => {
    // A status with no specific handler falls through to the raw git error,
    // which still carries the number — better than a wrong verdict.
    for (const status of [500, 502, 503, 400]) {
      expect(withStatus(status)?.code).not.toBe('push_outcome_unknown')
    }
  })

  it('says a dropped connection may have LANDED, rather than reporting plain failure', () => {
    // The server may have applied it; the response just never arrived. Read as
    // a failure, the agent's next move is compensating — `push --force` or a
    // reset — against a trunk that already moved.
    const failure = classifyPushTransportFailure(
      new Error(
        'error: RPC failed; curl 52 Empty reply from server\n' +
          'send-pack: unexpected disconnect while reading sideband packet\n' +
          'fatal: the remote end hung up unexpectedly',
      ),
    )
    expect(failure).toMatchObject({ code: 'push_outcome_unknown' })
    expect(failure?.error).toMatch(/may have landed/i)
    expect(failure?.error).toMatch(/do not force-push or reset/i)
  })
})




describe('only the TRANSPORT may report an HTTP status', () => {
  // A `remote:` line is the server's stdout relayed verbatim — a pre-receive
  // hook can print anything, including something status-shaped. Coding that as
  // a transport verdict tells a caller their credentials are wrong about a
  // push that authenticated fine and was refused on content.
  it('ignores a status-shaped hook line for every code it decides', () => {
    for (const status of [401, 403, 409, 413, 422, 429]) {
      const failure = classifyPushTransportFailure(
        new Error(
          `remote: error: ${status} refused by our pre-receive policy\n` +
            'To https://deploy.deep.space/api/repo/app_x\n' +
            ' ! [remote rejected] main -> main (pre-receive hook declined)',
        ),
      )
      expect(failure, `remote: error: ${status}`).toBeNull()
    }
  })

  it('still classifies the same status when GIT reports it', () => {
    expect(
      classifyPushTransportFailure(
        new Error("fatal: unable to access 'https://x/': The requested URL returned error: 403"),
      ),
    ).toMatchObject({ code: 'forbidden' })
    expect(
      classifyPushTransportFailure(new Error('error: RPC failed; HTTP 401 curl 22')),
    ).toMatchObject({ code: 'not_authenticated' })
  })

  it('reads git’s own line even when a hook line precedes it', () => {
    // The hook line is skipped, not the whole message.
    expect(
      classifyPushTransportFailure(
        new Error(
          'remote: error: 403 our policy says no\n' +
            'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413',
        ),
      ),
    ).toMatchObject({ code: 'push_too_large' })
  })
})

describe('the refusal grammar is parsed, never the prose', () => {
  it('parses `<code>: <sentence>` and nothing else', () => {
    expect(parseRefusalCode('push_too_large: object exceeds the 20 MiB limit')).toEqual({
      code: 'push_too_large',
      sentence: 'object exceeds the 20 MiB limit',
    })
    // The optional detail rides along in the sentence.
    expect(parseRefusalCode('secret_committed: a secret is here — .env, .dev.vars')).toEqual({
      code: 'secret_committed',
      sentence: 'a secret is here',
      detail: '.env, .dev.vars',
    })
    for (const untagged of [
      'object exceeds the 20 MiB limit',
      'Not A Code: something',
      'has-a-hyphen: something',
      'trailing_colon:no space',
      '',
    ]) {
      expect(parseRefusalCode(untagged), untagged).toBeNull()
    }
  })

  it('maps every server code to its CLI slug', () => {
    const expected: Record<string, string> = {
      push_too_large: 'push_too_large',
      repo_full: 'repo_full',
      secret_committed: 'secret_in_history',
      missing_objects: 'missing_objects',
      thin_pack: 'thin_pack',
      funny_refname: 'funny_refname',
      workspace_creator: 'workspace_creator',
      internal_ref: 'internal_ref',
      bad_tip: 'bad_tip',
      unpacker_error: 'unpacker_error',
    }
    for (const [serverCode, slug] of Object.entries(expected)) {
      // secret_committed needs its detail: without file names there is no
      // file-specific recovery, which is its own tested behaviour below.
      const detail = serverCode === 'secret_committed' ? ' — .env' : ''
      const verdict = classifyRejection(`${serverCode}: the server's own sentence${detail}`)
      expect(verdict.code, serverCode).toBe(slug)
      // Every code carries advice; none falls through to the catch-all prose.
      expect(verdict.message, serverCode).not.toContain('correct the reported history/ref problem')
    }
  })

  it('falls back to `rejected` for an untagged reason or a code it cannot explain', () => {
    // The rollout gap in full: an older worker sends no token, and a future
    // worker may send one this CLI version has no advice for. Neither invents
    // a slug, and the server's sentence still reaches the caller.
    for (const reason of [
      'object exceeds the 20 MiB limit',
      'some unrecognised server reason',
      'future_server_code: a condition this CLI cannot explain',
    ]) {
      const verdict = classifyRejection(reason)
      expect(verdict.code, reason).toBe('rejected')
    }
    expect(
      pushFailureMessage(
        'Push',
        {
          status: 'rejected',
          localRef: 'refs/heads/main',
          remoteRef: 'refs/heads/main',
          summary: '[remote rejected]',
          reason: 'future_server_code: a condition this CLI cannot explain',
          code: 'future_server_code',
        },
      ),
    ).toContain('a condition this CLI cannot explain')
  })

  it('a crafted FILENAME can no longer steal a code — the parse is at offset 0', () => {
    // The whole reason the grammar exists. A refusal sentence embeds paths the
    // pusher chose, so a file literally named after another code must not
    // reclassify the refusal that names it.
    const crafted = 'secret_committed: a secret is in this history — push_too_large: x'
    const verdict = classifyRejection(crafted)
    expect(verdict.code).toBe('secret_in_history')
    expect(verdict.code).not.toBe('push_too_large')
    expect(parseRefusalCode(crafted)?.code).toBe('secret_committed')

    // …and the reverse: a size refusal naming a secret-shaped path stays sized.
    const reverse = 'push_too_large: object exceeds the cap — secret_committed: .env.bin'
    expect(classifyRejection(reverse).code).toBe('push_too_large')

    // A code-shaped token anywhere but position 0 is just text.
    expect(classifyRejection('the file repo_full: notes.txt is too big').code).toBe('rejected')
  })
})

describe('an atomic push reports the ref that actually failed', () => {
  const ngLine = (ref: string, reason: string) =>
    `!\trefs/heads/${ref}:refs/heads/${ref}\t[remote rejected] (${reason})`

  it('skips `not_attempted` siblings when picking the verdict', () => {
    // A push is atomic: one refusal marks every sibling `not_attempted`. Those
    // lines say nothing about the cause, and taking the first blindly reports
    // whichever ref happened to sort first — sending someone to "fetch first"
    // for a secret refusal that pulling cannot touch.
    const results = parsePushPorcelain(
      [
        ngLine('a', 'not_attempted: not attempted — the push is atomic and another ref was refused'),
        ngLine('b', 'secret_committed: committed secret: remove it — .env'),
      ].join('\n'),
    )
    expect(results).toHaveLength(2)
    const verdict = representativeResult(results)
    expect(verdict.code).toBe('secret_committed')
    expect(classifyRejection(verdict.reason!).code).toBe('secret_in_history')
  })

  it('finds the real refusal wherever it sits among the siblings', () => {
    const results = parsePushPorcelain(
      [
        ngLine('a', 'not_attempted: not attempted'),
        ngLine('b', 'not_attempted: not attempted'),
        ngLine('c', 'push_too_large: object exceeds the push size limit'),
      ].join('\n'),
    )
    expect(representativeResult(results).code).toBe('push_too_large')
  })

  it('falls back to the first line when every ref was un-attempted', () => {
    // Should not happen — something refused the push — but reporting nothing
    // would be worse than reporting the un-attempted state honestly.
    const results = parsePushPorcelain(ngLine('a', 'not_attempted: not attempted'))
    const verdict = representativeResult(results)
    expect(verdict.code).toBe('not_attempted')
    expect(classifyRejection(verdict.reason!).code).toBe('rejected')
    expect(classifyRejection(verdict.reason!).message).toContain('deepspace feedback')
  })
})

describe('only the table’s OWN keys are refusal codes', () => {
  // `__proto__`, `constructor` and `toString` all match `^[a-z_]+$` and all
  // resolve through the prototype chain. A bare index answered them with a
  // TypeError (`__proto__` is an object, not a function) or with a slug-less
  // verdict (`constructor` returns its argument, so `.code` was undefined and
  // `--json` carried no code at all).
  it('treats inherited property names as unknown codes', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const reason = `${name}: something the pusher chose`
      expect(() => classifyRejection(reason), name).not.toThrow()
      const verdict = classifyRejection(reason)
      expect(verdict.code, name).toBe('rejected')
      expect(verdict.message, name).toBeTruthy()
    }
  })

  it('still answers the real codes', () => {
    expect(classifyRejection('push_too_large: over the cap').code).toBe('push_too_large')
  })
})

describe('the detail is parsed, and the files it names are used', () => {
  it('splits the remainder on the FIRST ` — `', () => {
    // Sentences contain that dash themselves, so a last-separator split would
    // treat half the advice as a filename.
    expect(
      parseRefusalCode(
        'secret_committed: committed secret: remove it from the history being pushed — .env, .dev.vars',
      ),
    ).toEqual({
      code: 'secret_committed',
      sentence: 'committed secret: remove it from the history being pushed',
      detail: '.env, .dev.vars',
    })
    expect(parseRefusalCode('repo_full: at the ceiling')).toEqual({
      code: 'repo_full',
      sentence: 'at the ceiling',
    })
  })

  it('names the secret files the server reported', () => {
    const verdict = classifyRejection(
      'secret_committed: committed secret: remove it from the history being pushed — .env, .dev.vars',
    )
    expect(verdict.code).toBe('secret_in_history')
    expect(verdict.message).toContain('.env')
    expect(verdict.message).toMatch(/rewrite the history/i)
    expect(verdict.message).toMatch(/rotate/i)
  })

  it('keeps the slug when the server sends no detail to name', () => {
    // The code alone establishes the condition; the names only sharpen the
    // recovery, so a detail-less refusal is still `secret_in_history` with a
    // generic history-rewrite sentence.
    expect(classifyRejection('secret_committed: committed secret').code).toBe('secret_in_history')
  })
})

describe('a mixed atomic report cannot hide the refusal', () => {
  it('prefers the refused ref over a successful one', () => {
    // `[up to date]` sorts first and carries no code, so a "first line that
    // is not not_attempted" rule answered with it — reporting success for a
    // push that was refused on another ref.
    const results = parsePushPorcelain(
      [
        '=\trefs/heads/a:refs/heads/a\t[up to date]',
        '!\trefs/heads/b:refs/heads/b\t[remote rejected] (secret_committed: committed secret — .env)',
      ].join('\n'),
    )
    expect(results.map((r) => r.status)).toEqual(['up_to_date', 'rejected'])
    expect(representativeResult(results).code).toBe('secret_committed')
  })

  it('still prefers a real refusal over an un-attempted sibling', () => {
    const results = parsePushPorcelain(
      [
        '=\trefs/heads/a:refs/heads/a\t[up to date]',
        '!\trefs/heads/b:refs/heads/b\t[remote rejected] (not_attempted: not attempted)',
        '!\trefs/heads/c:refs/heads/c\t[remote rejected] (push_too_large: over the cap)',
      ].join('\n'),
    )
    expect(representativeResult(results).code).toBe('push_too_large')
  })

  it('returns a successful line only when nothing was refused', () => {
    const results = parsePushPorcelain('=\trefs/heads/a:refs/heads/a\t[up to date]')
    expect(representativeResult(results).status).toBe('up_to_date')
  })
})

describe('the detail split survives a sentence that itself contains ` — `', () => {
  it('cuts at the FIRST separator, not the last', () => {
    // The earlier fixture had exactly one dash, so `lastIndexOf` passed it.
    // The grammar puts the detail after the FIRST separator; a sentence that
    // carries its own dash is what tells the two rules apart.
    expect(parseRefusalCode('repo_full: over the limit — rewrite history — 41943040 bytes')).toEqual(
      {
        code: 'repo_full',
        sentence: 'over the limit',
        detail: 'rewrite history — 41943040 bytes',
      },
    )
  })

  it('keeps a multi-file detail whole for the advice to name', () => {
    const parsed = parseRefusalCode('secret_committed: committed secret — .env, .dev.vars, x.envrc')
    expect(parsed?.detail).toBe('.env, .dev.vars, x.envrc')
    const verdict = classifyRejection(
      'secret_committed: committed secret — .env, .dev.vars, x.envrc',
    )
    expect(verdict.message).toContain('.env')
  })
})

describe('pushFailureMessage composes one sentence, not two verbs', () => {
  it('supplies the verb, so the subject must not carry one', () => {
    // Staging read "The cloud repo rejected main failed (rejected: …)" — a
    // caller passed a clause where a noun phrase belongs.
    const line = pushFailureMessage('The push of main', {
      status: 'rejected',
      localRef: 'refs/heads/main',
      remoteRef: 'refs/heads/main',
      summary: '[remote rejected]',
      reason: 'push_too_large: object exceeds the push size limit',
      code: 'push_too_large',
    })
    expect(line).toMatch(/^The push of main failed \(rejected: /)
    expect(line).not.toMatch(/rejected \w+ failed/)
  })
})
