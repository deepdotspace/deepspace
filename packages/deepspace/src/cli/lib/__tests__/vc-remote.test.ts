/** Remote URL, environment-only auth, and credential-helper behavior. */

import { execFileSync } from 'node:child_process'
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
  removeSpaceRemote,
  gitAuthEnv,
  gitSourceImportEnv,
  repoUrl,
  spacePrivateRef,
  spaceRemoteName,
  spaceTrackingRef,
  SPACE_REMOTE,
} from '../vc-remote'

// Real-git suite: every test shells out to git in scratch repos (~2s solo)
// and blows the default 5s wall under parallel vitest workers — the drifting
// 18-24 failures in docs/audits/2026-08-06-e2e-0.13.0. Headroom, not a
// license to hang.
vi.setConfig({ testTimeout: 30_000 })

describe('source environment isolation', () => {
  it('assigns distinct remotes and client-only refs to production and staging', () => {
    expect(spaceRemoteName('production')).toBe('space')
    expect(spaceRemoteName('staging')).toBe('space-staging')
    expect(spaceRemoteName('invalid')).toBe('space-invalid')
    expect(spaceTrackingRef('main', spaceRemoteName('production'))).toBe('refs/remotes/space/main')
    expect(spaceTrackingRef('main', spaceRemoteName('staging'))).toBe('refs/remotes/space-staging/main')
    expect(spacePrivateRef('pushed/main', 'production')).toBe('refs/deepspace/pushed/main')
    expect(spacePrivateRef('pushed/main', 'staging')).toBe('refs/deepspace/staging/pushed/main')
  })

  it('binds the process-wide defaults to staging before commands load', async () => {
    const savedEnvironment = process.env.DEEPSPACE_ENV
    process.env.DEEPSPACE_ENV = 'staging'
    vi.resetModules()
    try {
      const staging = await import('../vc-remote')
      expect(staging.SPACE_REMOTE).toBe('space-staging')
      expect(staging.spaceTrackingRef('main')).toBe('refs/remotes/space-staging/main')
      expect(staging.spacePrivateRef('pushed/main')).toBe('refs/deepspace/staging/pushed/main')
    } finally {
      if (savedEnvironment === undefined) delete process.env.DEEPSPACE_ENV
      else process.env.DEEPSPACE_ENV = savedEnvironment
      vi.resetModules()
    }
  })
})

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
      expect(credentialHelperCommand('staging')).toContain('!DEEPSPACE_ENV=staging ')
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

  const git = (args: string[]): string => runGit(repo, args).stdout.toString('utf-8').trim()

  // Every env change goes through vi.stubEnv. A module-scope
  // `const saved = process.env.X` snapshot is taken at COLLECTION time —
  // before the suite-wide setup file's beforeAll has redirected git's config —
  // so restoring from it DELETED `GIT_CONFIG_GLOBAL` and left every later
  // describe writing a credential helper into the real `~/.gitconfig`.
  beforeEach(() => {
    vi.stubEnv('DEEPSPACE_DEPLOY_URL', 'https://deploy.test')
    configDir = mkdtempSync(join(tmpdir(), 'ds-vcr-cfg-'))
    globalConfig = join(configDir, 'gitconfig')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null')
    repo = mkdtempSync(join(tmpdir(), 'ds-vcr-'))
    initRepo(repo, 'main')
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repo, 'a.txt'), 'v1\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'base'])
  })

  afterEach(() => {
    vi.unstubAllEnvs()
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

  it('keeps a staging source remote separate from production', () => {
    const productionUrl = ensureSpaceRemote(repo, 'app_01PRODUCTION')
    const stagingUrl = ensureSpaceRemote(repo, 'app_01STAGING', 'space-staging')

    expect(git(['remote', 'get-url', SPACE_REMOTE])).toBe(productionUrl)
    expect(git(['remote', 'get-url', 'space-staging'])).toBe(stagingUrl)
    expect(stagingUrl).toContain('app_01STAGING')
  })

  it('replaces a staging-pinned helper before production authentication', () => {
    const key = 'credential.https://deploy.test.helper'
    runGit(repo, ['config', '--global', '--add', key, ''])
    runGit(repo, [
      'config',
      '--global',
      '--add',
      key,
      `!DEEPSPACE_ENV=staging ${shQuote(process.execPath)} ${shQuote(process.argv[1])} git-credential`,
    ])

    ensureSpaceRemote(repo, 'app_01PRODUCTION')

    const helpers = runGit(repo, ['config', '--global', '--get-all', key])
      .stdout.toString('utf-8').split('\n').slice(0, -1)
    expect(helpers).toHaveLength(2)
    expect(helpers[1]).not.toContain('DEEPSPACE_ENV=staging')
    expect(helpers[1]).toContain('git-credential')
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

describe('a checkout owns every app id it declares', () => {

  it('accepts an [env.*] app id from the same wrangler.toml', () => {
    // A wrangler env is a separate app sharing this working tree — that is the
    // shipped multi-environment model, and `deploy --env staging` resolves the
    // env's id. Comparing against the top-level id alone made that command
    // structurally impossible, with advice ("run from that app's own
    // checkout") the model gives no way to follow.
    const repo = mkdtempSync(join(tmpdir(), 'ds-envapp-'))
    try {
      runGit(repo, ['init', '--quiet'])
      writeFileSync(
        join(repo, 'wrangler.toml'),
        [
          'name = "atlas"',
          '[vars]',
          'DEEPSPACE_APP_ID = "app_01ARZ3NDEKTSV4RRFFQ69G5FAV"',
          '[env.staging.vars]',
          'DEEPSPACE_APP_ID = "app_01BX5ZZKBKACTAV9WEVGEMMVRY"',
        ].join('\n'),
      )
      expect(() => ensureSpaceRemote(repo, 'app_01BX5ZZKBKACTAV9WEVGEMMVRY')).not.toThrow()
      expect(() => ensureSpaceRemote(repo, 'app_01ARZ3NDEKTSV4RRFFQ69G5FAV')).not.toThrow()
      // …and a genuinely foreign app is still refused.
      expect(() => ensureSpaceRemote(repo, 'app_01CCCCCCCCCCCCCCCCCCCCCCCC')).toThrowError(
        /This checkout declares/,
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not claim a mismatch when the config cannot be read', () => {
    // A half-edited wrangler.toml is not evidence that this is another app's
    // checkout, and ~56 call sites — including read-only ones — run through
    // here.
    const repo = mkdtempSync(join(tmpdir(), 'ds-badtoml-'))
    try {
      runGit(repo, ['init', '--quiet'])
      writeFileSync(join(repo, 'wrangler.toml'), 'name = "atlas"\n[vars\nbroken')
      expect(() => ensureSpaceRemote(repo, 'app_01ARZ3NDEKTSV4RRFFQ69G5FAV')).not.toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('the git-identity fold', () => {
  /** A token whose payload `decodeJwtPayload` can read; only the middle
   *  segment is ever parsed, so the signature is irrelevant here. */
  const tokenFor = (payload: Record<string, unknown>): string =>
    `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

  const token = tokenFor({ email: 'dev@example.com', name: 'Dev Eloper' })
  const APP = 'app_01ARZ3NDEKTSV4RRFFQ69G5FAV'

  // Isolate git from the developer's own global identity: `git config --get`
  // reads it, so on a normally-configured machine nothing is ever missing and
  // every assertion here would pass vacuously.
  beforeEach(() => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
    vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const freshRepo = (): string => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-ident-'))
    initRepo(repo, 'main')
    return repo
  }
  const configured = (repo: string, key: string): string =>
    runGit(repo, ['config', '--local', '--get', key], { allowFail: true })
      .stdout.toString('utf-8')
      .trim()

  it('fills in a missing identity when the caller hands over its token', () => {
    // The fold is the point: identity used to be an adjacent call each verb
    // had to remember, and the ones that forgot died on git's
    // "unable to auto-detect email address" — including inside the `git pull`
    // a divergence refusal hands back as its recovery.
    const repo = freshRepo()
    try {
      ensureSpaceRemote(repo, APP, undefined, token)
      expect(configured(repo, 'user.email')).toBe('dev@example.com')
      expect(configured(repo, 'user.name')).toBe('Dev Eloper')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('writes NOTHING when no token is passed — a read-only verb owns no config', () => {
    const repo = freshRepo()
    try {
      ensureSpaceRemote(repo, APP)
      expect(configured(repo, 'user.email')).toBe('')
      expect(configured(repo, 'user.name')).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('respects user.useConfigOnly, in every spelling git accepts', () => {
    // The flag means "never guess my identity". Guessing anyway — silently,
    // in a repo deliberately left unconfigured — is what it exists to
    // prevent, and a literal `=== "true"` string compare honoured only one of
    // the spellings git treats as true.
    for (const spelling of ['true', 'yes', 'on', '1']) {
      const repo = freshRepo()
      try {
        runGit(repo, ['config', '--local', 'user.useConfigOnly', spelling])
        ensureSpaceRemote(repo, APP, undefined, token)
        expect(configured(repo, 'user.email'), spelling).toBe('')
        expect(configured(repo, 'user.name'), spelling).toBe('')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  })

  it('never overwrites an identity the user set', () => {
    const repo = freshRepo()
    try {
      runGit(repo, ['config', '--local', 'user.email', 'mine@example.com'])
      runGit(repo, ['config', '--local', 'user.name', 'Mine'])
      ensureSpaceRemote(repo, APP, undefined, token)
      expect(configured(repo, 'user.email')).toBe('mine@example.com')
      expect(configured(repo, 'user.name')).toBe('Mine')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('announces the write on STDERR, with the undo', () => {
    // It writes to a file the user owns, so it says so — and to stderr
    // ALWAYS, because `--json` promises exactly one document on stdout and a
    // chatty repair on the commonest bootstrap path (a fresh clone's first
    // `--json` call) would make that document unparseable.
    const repo = freshRepo()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      ensureSpaceRemote(repo, APP, undefined, token)
      const notice = stderr.mock.calls.map((call) => String(call[0])).join('')
      expect(notice).toContain('dev@example.com')
      expect(notice).toContain('--unset user.email')
      expect(notice).toContain('--unset user.name')
    } finally {
      stderr.mockRestore()
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('leaves git alone when the token carries no email', () => {
    const repo = freshRepo()
    try {
      ensureSpaceRemote(repo, APP, undefined, tokenFor({ name: 'No Email' }))
      expect(configured(repo, 'user.email')).toBe('')
      expect(configured(repo, 'user.name')).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('app_checkout_mismatch, end to end', () => {

  const OTHER = 'app_01BX5ZZKBKACTAV9WEVGEMMVRY'
  const MINE = 'app_01ARZ3NDEKTSV4RRFFQ69G5FAV'

  it('refuses to re-aim a checkout that declares a different app', () => {
    // `push -a <other-app>` from app A's checkout repoints the remote, and a
    // later plain `git push` then publishes A's source into B's cloud repo,
    // exit 0. The refusal names both ids and both ways forward.
    const repo = mkdtempSync(join(tmpdir(), 'ds-mismatch-'))
    try {
      initRepo(repo, 'main')
      writeFileSync(
        join(repo, 'wrangler.toml'),
        ['name = "atlas"', '[vars]', `DEEPSPACE_APP_ID = "${MINE}"`].join('\n'),
      )
      let thrown: unknown
      try {
        ensureSpaceRemote(repo, OTHER)
      } catch (err) {
        thrown = err
      }
      expect((thrown as { code?: string }).code).toBe('app_checkout_mismatch')
      const message = (thrown as Error).message
      expect(message).toContain(MINE)
      expect(message).toContain(OTHER)
      expect(message).toContain(`deepspace clone ${OTHER}`)
      expect(message).toContain('deepspace app init --new-id')
      // And the remote was NOT touched on the way out.
      expect(
        runGit(repo, ['remote', 'get-url', SPACE_REMOTE], { allowFail: true }).status,
      ).not.toBe(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does NOT refuse a directory that declares no app of its own', () => {
    // A clone target sitting inside another app's checkout has no
    // wrangler.toml of its own, and `hasWranglerConfig` does not walk up — so
    // there is no declaration to contradict. Refusing here would break
    // `deepspace clone` run from anywhere inside an existing app.
    const outer = mkdtempSync(join(tmpdir(), 'ds-nested-'))
    try {
      writeFileSync(
        join(outer, 'wrangler.toml'),
        ['name = "atlas"', '[vars]', `DEEPSPACE_APP_ID = "${MINE}"`].join('\n'),
      )
      const target = join(outer, 'cloned')
      mkdirSync(target)
      initRepo(target, 'main')
      expect(() => ensureSpaceRemote(target, OTHER)).not.toThrow()
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })
})

describe('the mismatch guard is scoped to RE-AIMING, not to ownership', () => {

  const A = 'app_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const B = 'app_01BX5ZZKBKACTAV9WEVGEMMVRY'

  const repoDeclaring = (appId: string): string => {
    const repo = mkdtempSync(join(tmpdir(), 'ds-reaim-'))
    initRepo(repo, 'main')
    writeFileSync(
      join(repo, 'wrangler.toml'),
      ['name = "atlas"', '[vars]', `DEEPSPACE_APP_ID = "${appId}"`].join('\n'),
    )
    return repo
  }

  it('allows a clone whose committed wrangler.toml names the app it was forked from', () => {
    // `deepspace clone <B>` sets the remote to B and THEN calls this to install
    // the credential helper. A fork whose id was never re-committed (or an id
    // changed server-side) still declares A, and refusing here stranded the
    // clone after the whole transfer had already landed: repo on disk, no
    // helper, exit 1. The remote already points at B, so nothing is being
    // re-aimed and the declaration is not evidence of anything.
    const repo = repoDeclaring(A)
    try {
      runGit(repo, ['remote', 'add', SPACE_REMOTE, repoUrl(B)])
      expect(() => ensureSpaceRemote(repo, B)).not.toThrow()
      expect(
        runGit(repo, ['remote', 'get-url', SPACE_REMOTE]).stdout.toString('utf-8').trim(),
      ).toBe(repoUrl(B))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('still refuses to re-aim a remote that points somewhere else', () => {
    // The `push -a <other>` shape the guard exists for: the remote serves A,
    // the checkout declares A, and the command wants to move it to a third app.
    const repo = repoDeclaring(A)
    try {
      runGit(repo, ['remote', 'add', SPACE_REMOTE, repoUrl(A)])
      expect(() => ensureSpaceRemote(repo, B)).toThrowError(/This checkout declares/)
      // …and the remote was left serving A.
      expect(
        runGit(repo, ['remote', 'get-url', SPACE_REMOTE]).stdout.toString('utf-8').trim(),
      ).toBe(repoUrl(A))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('still refuses when there is no remote yet and the declaration excludes the target', () => {
    // With no remote, the declaration is the only evidence there is.
    const repo = repoDeclaring(A)
    try {
      expect(() => ensureSpaceRemote(repo, B)).toThrowError(/This checkout declares/)
      expect(runGit(repo, ['remote', 'get-url', SPACE_REMOTE], { allowFail: true }).status).not.toBe(
        0,
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('repairs the URL when the remote serves the target on another base', () => {
    // Same app, different deploy service (a staging override left behind).
    // Nothing is re-aimed — the app is unchanged — so the URL is repaired
    // rather than refused.
    const repo = repoDeclaring(A)
    try {
      runGit(repo, ['remote', 'add', SPACE_REMOTE, repoUrl(B, 'https://old.example')])
      expect(() => ensureSpaceRemote(repo, B)).not.toThrow()
      expect(
        runGit(repo, ['remote', 'get-url', SPACE_REMOTE]).stdout.toString('utf-8').trim(),
      ).toBe(repoUrl(B))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('a refused mismatch writes nothing', () => {
  it('leaves .git/config untouched when the guard refuses WITH a token', () => {
    // The guard runs before `ensureGitIdentity`, and this is what pins that
    // order: without a token passed, the identity write never ran anyway, so
    // the assertion was vacuous.
    const token = `h.${Buffer.from(JSON.stringify({ email: 'dev@example.com', name: 'Dev' })).toString('base64url')}.s`
    const repo = mkdtempSync(join(tmpdir(), 'ds-refuse-write-'))
    try {
      initRepo(repo, 'main')
      writeFileSync(
        join(repo, 'wrangler.toml'),
        ['name = "atlas"', '[vars]', 'DEEPSPACE_APP_ID = "app_01ARZ3NDEKTSV4RRFFQ69G5FAV"'].join(
          '\n',
        ),
      )
      expect(() =>
        ensureSpaceRemote(repo, 'app_01BX5ZZKBKACTAV9WEVGEMMVRY', undefined, token),
      ).toThrowError(/This checkout declares/)

      const local = (key: string): string =>
        runGit(repo, ['config', '--local', '--get', key], { allowFail: true })
          .stdout.toString('utf-8')
          .trim()
      expect(local('user.email')).toBe('')
      expect(local('user.name')).toBe('')
      expect(runGit(repo, ['remote', 'get-url', SPACE_REMOTE], { allowFail: true }).status).not.toBe(
        0,
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('removeSpaceRemote against a real repository', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'deepspace-remove-remote-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('distinguishes an absent remote from one it removed', () => {
    expect(removeSpaceRemote(repo)).toBe(false)
    execFileSync('git', ['remote', 'add', SPACE_REMOTE, 'https://example.test/repo'], { cwd: repo })
    expect(removeSpaceRemote(repo)).toBe(true)
    expect(removeSpaceRemote(repo)).toBe(false)
  })
})
