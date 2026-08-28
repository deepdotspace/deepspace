import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError } from '../../lib/api'

// The session/token files are absolute module constants pointing into the real
// user's home, so they are redirected into a temp dir here: a status test must
// never read (or depend on) the developer's own login.
const authFixture = await vi.hoisted(async () => {
  // Hoisted above the imports, so the module graph sees these paths from the
  // start — node builtins are reached through dynamic import for the same reason.
  const fs = await import('node:fs')
  const path = await import('node:path')
  const os = await import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-status-auth-'))
  return {
    session: path.join(dir, 'session.json'),
    token: path.join(dir, 'token.jwt'),
    ensureToken: vi.fn(),
  }
})

vi.mock('../../auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth')>()
  return {
    ...actual,
    SESSION_PATH: authFixture.session,
    TOKEN_PATH: authFixture.token,
    ensureToken: authFixture.ensureToken,
  }
})

import { resolveStatusApp, statusRemoteFailure } from '../status'
import status from '../status'
import * as authModule from '../../auth'
import * as appContext from '../../lib/app-context'
import * as repoApiModule from '../../lib/repo-api'
import * as sourceApiModule from '../../lib/source-api'
import * as appTargetModule from '../../lib/app-target'


describe('statusRemoteFailure', () => {
  it('preserves an app-not-found response instead of calling it unreachable', () => {
    const failure = statusRemoteFailure(
      new ApiError(
        'App is not registered — deploy or push from the owning account first',
        404,
        'app_not_found',
      ),
    )

    expect(failure).toEqual({
      human: 'App is not registered — deploy or push from the owning account first [app_not_found]',
      json: {
        state: 'unavailable',
        code: 'app_not_found',
        error: 'App is not registered — deploy or push from the owning account first',
      },
    })
  })

  it('keeps network failures visibly unreachable in both output forms', () => {
    const failure = statusRemoteFailure(
      new ApiError('Could not reach the deploy service', 0, 'network_error'),
    )

    expect(failure).toEqual({
      human: '(unreachable) — Could not reach the deploy service [network_error]',
      json: {
        state: 'unavailable',
        code: 'network_error',
        error: 'Could not reach the deploy service',
      },
    })
  })

  it('retains an untyped upstream message without inventing a code', () => {
    expect(statusRemoteFailure(new Error('socket closed'))).toEqual({
      human: 'socket closed',
      json: { state: 'unavailable', error: 'socket closed' },
    })
  })
})

describe('resolveStatusApp', () => {
  it('selects the name and app id from one named Wrangler environment', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'deepspace-status-env-'))
    writeFileSync(
      join(appDir, 'wrangler.toml'),
      `
name = "example"
[vars]
DEEPSPACE_APP_ID = "app_production"

[env.staging]
name = "example-staging"
[env.staging.vars]
DEEPSPACE_APP_ID = "app_01KZ84H3TC7ZX9P8V829MDFY5Y"
`,
    )

    expect(resolveStatusApp(appDir, 'staging')).toEqual({
      appName: 'example-staging',
      appId: 'app_01KZ84H3TC7ZX9P8V829MDFY5Y',
    })
  })
})

/**
 * `status --json` is the envelope agents branch on before doing anything else,
 * so its session keys are pinned as behavior: which files count as logged in,
 * that an unusable session is CODED rather than merely absent, that `user` is
 * never a placeholder, and that the trunk facts are reported off trunk too.
 */
describe('status --json session and trunk facts', () => {
  const APP_ID = 'app_01ABCDEFGHJKMNPQRSTVWXYZ00'
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' })

  let repo: string | undefined
  const clearAuthFiles = () => {
    for (const path of [authFixture.session, authFixture.token]) {
      try {
        unlinkSync(path)
      } catch {
        // absent is the state we want
      }
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    clearAuthFiles()
    process.exitCode = undefined
    if (repo) rmSync(repo, { recursive: true, force: true })
    repo = undefined
  })

  /** A token file whose payload decodes — status reads identity from it. */
  const writeToken = (payload: Record<string, unknown>) => {
    const b64 = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url')
    writeFileSync(authFixture.token, `${b64({ alg: 'none' })}.${b64(payload)}.sig`)
  }

  async function runStatusJson(): Promise<Record<string, unknown>> {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => logs.push(String(line)))
    const command = status as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { json: true } })
    return JSON.parse(logs[logs.length - 1]) as Record<string, unknown>
  }

  /** A real repo on `branch`, with an app id, plus the cloud reads stubbed. */
  function stageCheckout(branch: string, cloudHead: string | null) {
    repo = mkdtempSync(join(tmpdir(), 'ds-status-'))
    git(repo, ['init', '-q', '-b', branch])
    git(repo, ['config', 'user.email', 't@t'])
    git(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'wrangler.toml'), `name = "example"\n[vars]\nDEEPSPACE_APP_ID = "${APP_ID}"\n`)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'initial'])
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(repo)
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId: APP_ID,
      source: { provider: 'deepspace' },
      revision: 1,
      registered: true,
    })
    vi.spyOn(appTargetModule, 'listApps').mockResolvedValue([])
    vi.spyOn(repoApiModule, 'repoApi').mockReturnValue({
      getRefs: async () => ({ refs: [], head: cloudHead }),
      latestRelease: async () => ({ release: null }),
      getWorkspace: async () => {
        throw new Error('no workspace')
      },
    } as unknown as ReturnType<typeof repoApiModule.repoApi>)
  }

  it('an UNCLAIMED app reports its next-deploy inference — deepspace without a GitHub remote', async () => {
    // v0.26.0 AX: the old line said "defaults to DeepSpace", false for a
    // GitHub-remote checkout; the JSON mirror must carry the same fact.
    clearAuthFiles()
    writeToken({ email: 'dev@example.com', sub: 'user_1' })
    stageCheckout('main', null)
    authFixture.ensureToken.mockResolvedValue('token')
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId: APP_ID,
      source: null,
      revision: 0,
      registered: true,
    })
    const json = await runStatusJson()
    expect(json.source).toBeNull()
    expect(json.sourceInference).toBe('deepspace')
  })

  it('an UNCLAIMED app with a GitHub remote infers github and labels the trunk external+inferred', async () => {
    clearAuthFiles()
    writeToken({ email: 'dev@example.com', sub: 'user_1' })
    stageCheckout('main', null)
    authFixture.ensureToken.mockResolvedValue('token')
    git(repo!, ['remote', 'add', 'origin', 'https://github.com/acme/rockets.git'])
    vi.spyOn(sourceApiModule, 'getAppSource').mockResolvedValue({
      appId: APP_ID,
      source: null,
      revision: 0,
      registered: true,
    })
    const json = await runStatusJson()
    expect(json.sourceInference).toBe('github')
    // The trunk row must not compare the checkout against the intentionally
    // empty cloud repo and report `differs` (v0.26.0 github AX-8).
    expect(json.trunk).toMatchObject({ state: 'external', provider: 'github', inferred: true })
  })

  it('reports NOT logged in with a coded sessionError and no user', async () => {
    clearAuthFiles()
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(null)

    const json = await runStatusJson()

    expect(json.loggedIn).toBe(false)
    expect(json.sessionError).toEqual({
      state: 'unavailable',
      error: 'Not logged in. Run `deepspace auth login` first.',
      code: 'not_authenticated',
    })
    expect(json).not.toHaveProperty('user')
  })

  it('counts a TOKEN alone as logged in — it is a live credential', async () => {
    // Keying on the session file alone made status contradict `auth whoami`
    // and sent agents into a browser OAuth nobody was there to complete.
    clearAuthFiles()
    writeToken({ email: 'dev@example.com', sub: 'user_1' })
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(null)

    const json = await runStatusJson()

    expect(json.loggedIn).toBe(true)
    expect(json.user).toBe('dev@example.com')
    expect(json).not.toHaveProperty('sessionError')
  })

  it('omits `user` rather than emitting a placeholder when the token carries no email', async () => {
    clearAuthFiles()
    writeToken({ sub: 'user_1' })
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(null)

    const json = await runStatusJson()

    expect(json.loggedIn).toBe(true)
    // A placeholder string here silently fails an identity comparison.
    expect(json).not.toHaveProperty('user')
  })

  it('an UNDECODABLE token with a DEAD session is stated as a session error, not read as healthy', async () => {
    // 2026-08-28 collab AX F1: a garbage credential pair reported
    // `loggedIn: true` with no `sessionError`, while every other verb
    // answered not_authenticated. An undecodable token alone is only a
    // corrupt CACHE — ensureToken() decides, exactly as every verb does.
    clearAuthFiles()
    writeFileSync(authFixture.session, 'not-a-real-session-token-garbage')
    writeFileSync(authFixture.token, 'garbage.not.a.jwt')
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(null)
    vi.spyOn(authModule, 'ensureToken').mockRejectedValue(
      new Error('Session expired. Run `deepspace auth login`.'),
    )

    const json = await runStatusJson()

    expect(json.loggedIn).toBe(false)
    expect(json).toHaveProperty('sessionError')
    expect(json).not.toHaveProperty('user')
  })

  it('an undecodable token beside a VALID session self-heals and reads as logged in', async () => {
    // The token file is a non-atomically-written cache; a truncated one with
    // a live session is healthy (ensureToken re-mints). Declaring it dead
    // would start the interactive login nobody is there to complete — the
    // exact inversion the first cut of this fix shipped (caught in review).
    clearAuthFiles()
    writeFileSync(authFixture.session, 'valid-session-token')
    writeFileSync(authFixture.token, 'garbage.not.a.jwt')
    vi.spyOn(appContext, 'findAppDir').mockReturnValue(null)
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    vi.spyOn(authModule, 'ensureToken').mockResolvedValue(
      `${b64({ alg: 'none' })}.${b64({ email: 'dev@example.com', sub: 'user_1' })}.sig`,
    )

    const json = await runStatusJson()

    expect(json.loggedIn).toBe(true)
    expect(json.user).toBe('dev@example.com')
    expect(json).not.toHaveProperty('sessionError')
  })

  it('clears loggedIn and user on an EXPIRED session, and codes it', async () => {
    // The envelope used to assert `loggedIn: true` and `sessionExpired: true`
    // at once, and report an identity read from the dead token — which
    // compares equal to a live one.
    clearAuthFiles()
    writeToken({ email: 'dev@example.com', sub: 'user_1' })
    stageCheckout('main', 'refs/heads/main')
    authFixture.ensureToken.mockRejectedValue(new ApiError('session expired', 401, 'unauthorized'))

    const json = await runStatusJson()

    expect(json.sessionExpired).toBe(true)
    expect(json.loggedIn).toBe(false)
    expect(json).not.toHaveProperty('user')
    expect(json.sessionError).toEqual({
      state: 'unavailable',
      error: 'Session expired. Run `deepspace auth login`.',
      code: 'not_authenticated',
    })
  })

  it('reports defaultBranch and names the trunk when the checkout is OFF it', async () => {
    clearAuthFiles()
    writeToken({ email: 'dev@example.com', sub: 'user_1' })
    stageCheckout('feature/x', 'refs/heads/main')
    authFixture.ensureToken.mockResolvedValue('token')

    const messages: string[] = []
    const { log } = await import('@clack/prompts')
    vi.spyOn(log, 'message').mockImplementation((line?: unknown) => messages.push(String(line)))

    const json = await runStatusJson()

    // The one fact behind "what does `workspace land` merge into?".
    expect(json.defaultBranch).toBe('main')
    // Off trunk, the sync row is about THIS branch, so it is relabelled and
    // the default branch gets named on its own row.
    expect(json.trunk).toMatchObject({ branch: 'feature/x', isTrunk: false })
  })

  it('renders the Trunk row naming the default branch on a non-trunk checkout', async () => {
    clearAuthFiles()
    writeToken({ email: 'dev@example.com', sub: 'user_1' })
    stageCheckout('feature/x', 'refs/heads/main')
    authFixture.ensureToken.mockResolvedValue('token')

    const rows: string[] = []
    const { log } = await import('@clack/prompts')
    vi.spyOn(log, 'message').mockImplementation((line?: unknown) => rows.push(String(line)))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const command = status as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({ args: { json: false } })

    // Without it the human view had no tell at all that trunk is elsewhere.
    expect(rows.some((row) => /^Trunk\s+main \(this checkout is on feature\/x\)/.test(row))).toBe(
      true,
    )
    // And the branch's own sync state is NOT labelled "Trunk".
    expect(rows.some((row) => row.startsWith('Branch sync'))).toBe(true)
  })
})
