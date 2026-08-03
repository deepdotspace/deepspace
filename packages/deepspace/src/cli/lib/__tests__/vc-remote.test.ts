/** Remote URL, environment-only auth, and credential-helper behavior. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shQuote } from '../cli-format'
import { runGit } from '../git/process'
import { initRepo } from '../git/repository'
import {
  credentialHelperCommand,
  ensureSpaceRemote,
  gitAuthEnv,
  gitSourceImportEnv,
  repoUrl,
  SPACE_REMOTE,
} from '../vc-remote'

describe('credential-helper command safety', () => {
  it('shell-quotes every path and pins the running node plus CLI entry', () => {
    expect(shQuote('/opt/tools/node')).toBe("'/opt/tools/node'")
    expect(shQuote('/opt/(v2)/n;ode&x|y')).toBe("'/opt/(v2)/n;ode&x|y'")
    expect(shQuote("/a/o'b/node")).toBe("'/a/o'\\''b/node'")

    const savedPath = process.env.PATH
    process.env.PATH = ''
    try {
      const command = credentialHelperCommand()
      expect(command).toContain('git-credential')
      expect(command).not.toMatch(/!deepspace /)
      expect(command).toContain(process.execPath.split(/[\\/]/).pop() as string)
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe('repoUrl', () => {
  it('joins and normalizes the base URL', () => {
    expect(repoUrl('app_01ABC', 'https://deploy-worker.deep.space')).toBe(
      'https://deploy-worker.deep.space/api/repo/app_01ABC',
    )
    expect(repoUrl('app_01ABC', 'http://localhost:8787/')).toBe(
      'http://localhost:8787/api/repo/app_01ABC',
    )
  })

  it('URL-encodes the app id defensively', () => {
    expect(repoUrl('a/b', 'https://x.test')).toBe('https://x.test/api/repo/a%2Fb')
  })
})

describe('gitAuthEnv', () => {
  const savedCount = process.env.GIT_CONFIG_COUNT
  const savedUrl = process.env.DEEPSPACE_DEPLOY_URL

  afterEach(() => {
    if (savedCount === undefined) delete process.env.GIT_CONFIG_COUNT
    else process.env.GIT_CONFIG_COUNT = savedCount
    if (savedUrl === undefined) delete process.env.DEEPSPACE_DEPLOY_URL
    else process.env.DEEPSPACE_DEPLOY_URL = savedUrl
  })

  it('scopes the bearer header to the platform URL in environment config', () => {
    delete process.env.GIT_CONFIG_COUNT
    expect(gitAuthEnv('tok.en-123', 'https://deploy-worker.deep.space')).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://deploy-worker.deep.space.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer tok.en-123',
    })
  })

  it('appends after caller config rather than overwriting it', () => {
    process.env.GIT_CONFIG_COUNT = '1'
    const env = gitAuthEnv('tok', 'https://deploy.test')
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_1: 'http.https://deploy.test.extraHeader',
      GIT_CONFIG_VALUE_1: 'Authorization: Bearer tok',
    })
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined()
  })

  it('uses the same normalized default base as repository URLs', () => {
    delete process.env.GIT_CONFIG_COUNT
    expect(gitAuthEnv('t', 'https://deploy.test///').GIT_CONFIG_KEY_0).toBe(
      'http.https://deploy.test.extraHeader',
    )
    process.env.DEEPSPACE_DEPLOY_URL = 'https://default.test'
    expect(gitAuthEnv('t').GIT_CONFIG_KEY_0).toBe('http.https://default.test.extraHeader')
  })

  it('adds a revision-bound import header without replacing bearer auth', () => {
    delete process.env.GIT_CONFIG_COUNT
    expect(gitSourceImportEnv('tok', 7, 'https://deploy.test')).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://deploy.test.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer tok',
      GIT_CONFIG_KEY_1: 'http.https://deploy.test.extraHeader',
      GIT_CONFIG_VALUE_1: 'X-DeepSpace-Source-Revision: 7',
    })
  })
})

describe('ensureSpaceRemote against a real repository', () => {
  let repo: string
  let configDir: string
  let globalConfig: string
  const savedUrl = process.env.DEEPSPACE_DEPLOY_URL
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL

  const git = (args: string[]): string => runGit(repo, args).stdout.toString('utf-8').trim()

  beforeEach(() => {
    process.env.DEEPSPACE_DEPLOY_URL = 'https://deploy.test'
    configDir = mkdtempSync(join(tmpdir(), 'ds-vcr-cfg-'))
    globalConfig = join(configDir, 'gitconfig')
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    repo = mkdtempSync(join(tmpdir(), 'ds-vcr-'))
    initRepo(repo, 'main')
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'a.txt'), 'v1\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'base'])
  })

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.DEEPSPACE_DEPLOY_URL
    else process.env.DEEPSPACE_DEPLOY_URL = savedUrl
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal
    rmSync(repo, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  it('creates and re-aims the remote while installing a host-scoped helper', () => {
    const firstUrl = ensureSpaceRemote(repo, 'app_01TEST')
    expect(git(['remote', 'get-url', SPACE_REMOTE])).toBe(firstUrl)

    process.env.DEEPSPACE_DEPLOY_URL = 'https://other.test'
    const secondUrl = ensureSpaceRemote(repo, 'app_01TEST')
    expect(git(['remote', 'get-url', SPACE_REMOTE])).toBe(secondUrl)

    const helpers = runGit(repo, [
      'config',
      '--global',
      '--get-all',
      'credential.https://other.test.helper',
    ])
      .stdout.toString('utf-8')
      .split('\n')
      .slice(0, -1)
    expect(helpers[0]).toBe('')
    expect(helpers[1]).toContain('git-credential')
    expect(helpers[1]).toContain(process.execPath)
    expect(helpers[1]).not.toBe('!deepspace git-credential')
  })

  it('keeps an app-local CLI helper in worktree-private config', () => {
    const savedEntry = process.argv[1]
    process.argv[1] = join(repo, 'node_modules', 'deepspace', 'dist', 'cli.js')
    try {
      ensureSpaceRemote(repo, 'app_01LOCAL')
      const key = 'credential.https://deploy.test.helper'
      expect(runGit(repo, ['config', '--worktree', '--get-all', key]).status).toBe(0)
      expect(
        runGit(repo, ['config', '--local', '--get-all', key], { allowFail: true }).status,
      ).not.toBe(0)
      expect(
        runGit(repo, ['config', '--global', '--get-all', key], { allowFail: true }).status,
      ).not.toBe(0)
    } finally {
      process.argv[1] = savedEntry
    }
  })

  it('does not let a deleted client worktree poison a sibling helper', () => {
    const worktreeA = join(configDir, 'codex-a')
    const worktreeB = join(configDir, 'claude-b')
    git(['worktree', 'add', '--quiet', '-b', 'agent/a', worktreeA, 'HEAD'])
    git(['worktree', 'add', '--quiet', '-b', 'agent/b', worktreeB, 'HEAD'])
    const entry = (...parts: string[]) =>
      join(...parts, 'node_modules', 'deepspace', 'dist', 'cli.js')
    const entryA = entry(worktreeA)
    const entryB = entry(worktreeB)
    mkdirSync(join(entryA, '..'), { recursive: true })
    mkdirSync(join(entryB, '..'), { recursive: true })
    writeFileSync(entryA, '// a\n')
    writeFileSync(entryB, '// b\n')
    const savedEntry = process.argv[1]
    const key = 'credential.https://deploy.test.helper'
    try {
      process.argv[1] = entryA
      ensureSpaceRemote(worktreeA, 'app_01WORKTREES')
      process.argv[1] = entryB
      ensureSpaceRemote(worktreeB, 'app_01WORKTREES')

      rmSync(worktreeA, { recursive: true, force: true })
      const helperB = runGit(worktreeB, ['config', '--worktree', '--get-all', key]).stdout.toString(
        'utf-8',
      )
      expect(helperB).toContain(entryB)
      expect(helperB).not.toContain(entryA)
      expect(
        runGit(worktreeB, ['config', '--local', '--get-all', key], { allowFail: true }).status,
      ).not.toBe(0)
    } finally {
      process.argv[1] = savedEntry
    }
  })

  it('keeps remote re-aiming quiet in JSON mode', () => {
    ensureSpaceRemote(repo, 'app_01FIRST')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.argv.push('--json')
    try {
      ensureSpaceRemote(repo, 'app_01SECOND')
      expect(git(['remote', 'get-url', SPACE_REMOTE])).toContain('app_01SECOND')
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      process.argv.splice(process.argv.lastIndexOf('--json'), 1)
      stderr.mockRestore()
    }
  })

  it('lets real Git apply the scoped header only to platform repo URLs', () => {
    const env = gitAuthEnv('tok', 'https://deploy.test')
    const hit = runGit(
      repo,
      ['config', '--get-urlmatch', 'http.extraHeader', 'https://deploy.test/api/repo/app_01TEST'],
      { env },
    )
    expect(hit.stdout.toString('utf-8').trim()).toBe('Authorization: Bearer tok')
    const miss = runGit(
      repo,
      ['config', '--get-urlmatch', 'http.extraHeader', 'https://elsewhere.example.com/x'],
      { env, allowFail: true },
    )
    expect(miss.status).not.toBe(0)
    expect(miss.stdout.toString('utf-8').trim()).toBe('')
  })
})
