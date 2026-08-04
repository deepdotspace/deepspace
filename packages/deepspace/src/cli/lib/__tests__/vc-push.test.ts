/** Push porcelain parsing, real-Git transfer outcomes, and rejection guidance. */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGit } from '../git/process'
import { initRepo } from '../git/repository'
import {
  buildPushArgs,
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

  it('makes the full-pack retry self-contained instead of reusing historical deltas', () => {
    expect(buildPushArgs('refs/heads/main:refs/heads/main', {}, 'self-contained')).toEqual([
      '-c',
      'pack.window=0',
      '-c',
      'pack.depth=0',
      'push',
      '--porcelain',
      '--no-thin',
      SPACE_REMOTE,
      'refs/heads/main:refs/heads/main',
    ])
    expect(
      buildPushArgs('refs/heads/main:refs/heads/main', { force: true }, 'self-contained'),
    ).toContain('--force')
    expect(buildPushArgs('refs/heads/main:refs/heads/main')).toEqual([
      'push',
      '--porcelain',
      SPACE_REMOTE,
      'refs/heads/main:refs/heads/main',
    ])
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
      expect(named).toContain('git rm --cached')
      expect(named).not.toContain('rev-list')
      expect(pushFailureMessage('Workspace upload', rejected('object too large'), repo)).toContain(
        'retrying cannot succeed',
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
