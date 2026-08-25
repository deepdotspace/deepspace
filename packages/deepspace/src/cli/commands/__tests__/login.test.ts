/**
 * ONB-4: non-interactive login credential precedence.
 * ONB-7: `-e` alias parity for --env across dev/deploy/test.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import login, { createCliLoginSession, resolveLoginCredentials, loginModeDecision } from '../login'
import dev from '../dev'
import deploy from '../deploy'
import test from '../test'
import init from '../init'

describe('resolveLoginCredentials (ONB-4)', () => {
  it('prefers --password-stdin over --password and $DEEPSPACE_PASSWORD', () => {
    expect(
      resolveLoginCredentials({ passwordArg: 'flag', envPassword: 'env', passwordStdin: 'stdin' }),
    ).toEqual({ email: undefined, password: 'stdin' })
  })

  it('prefers --password over $DEEPSPACE_PASSWORD when no stdin', () => {
    expect(resolveLoginCredentials({ passwordArg: 'flag', envPassword: 'env' }).password).toBe(
      'flag',
    )
  })

  it('falls back to $DEEPSPACE_PASSWORD', () => {
    expect(resolveLoginCredentials({ envPassword: 'env' }).password).toBe('env')
  })

  it('returns an explicitly-empty stdin password as "" (run() then rejects it)', () => {
    expect(
      resolveLoginCredentials({ passwordArg: 'flag', envPassword: 'env', passwordStdin: '' })
        .password,
    ).toBe('')
  })

  it('email: --email over $DEEPSPACE_EMAIL, else the env', () => {
    expect(resolveLoginCredentials({ emailArg: 'a@x.com', envEmail: 'b@x.com' }).email).toBe(
      'a@x.com',
    )
    expect(resolveLoginCredentials({ envEmail: 'b@x.com' }).email).toBe('b@x.com')
    expect(resolveLoginCredentials({}).email).toBeUndefined()
  })
})

describe('loginModeDecision (ONB-4 — no silent OAuth fall-through)', () => {
  it('password mode when email + non-empty password present', () => {
    expect(loginModeDecision({ email: 'a@x.com', password: 'pw', passwordIntent: true }).mode).toBe(
      'password',
    )
  })
  it('oauth mode when no credentials were supplied at all', () => {
    expect(loginModeDecision({ passwordIntent: false }).mode).toBe('oauth')
  })
  it('ERRORS (not oauth) on an empty --password-stdin — the CI-hang footgun', () => {
    const d = loginModeDecision({ email: 'a@x.com', password: '', passwordIntent: true })
    expect(d.mode).toBe('error')
    expect(d.mode === 'error' && d.message).toMatch(/non-empty password/)
  })
  it('ERRORS when a password was supplied but no email', () => {
    const d = loginModeDecision({ password: 'pw', passwordIntent: true })
    expect(d.mode).toBe('error')
    expect(d.mode === 'error' && d.message).toMatch(/needs an email/)
  })
  // The slug is what an agent branches on; the two error modes must not
  // collapse to one code just because both are "bad credentials".
  it('carries a distinct slug per error mode', () => {
    const noEmail = loginModeDecision({ password: 'pw', passwordIntent: true })
    const noPassword = loginModeDecision({ email: 'a@x.com', password: '', passwordIntent: true })
    expect(noEmail.mode === 'error' && noEmail.code).toBe('missing_email')
    expect(noPassword.mode === 'error' && noPassword.code).toBe('missing_password')
  })
})

describe('browser login session creation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('retries a transient connection failure before returning the authorization URL', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        Response.json({ sessionId: 'session-id', loginUrl: 'https://auth.test/login' }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const session = createCliLoginSession('challenge')
    await vi.runAllTimersAsync()

    await expect(session).resolves.toEqual({
      sessionId: 'session-id',
      loginUrl: 'https://auth.test/login',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('--password-stdin streaming input', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    process.exitCode = undefined
  })

  it('reads a password arriving across ticks and strips one trailing newline', async () => {
    let index = 0
    const chunks = ['hunter', '2\n']
    const stream = new Readable({
      read() {
        setTimeout(() => this.push(index < chunks.length ? chunks[index++] : null), 1)
      },
    })
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream as unknown as typeof process.stdin)
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ message: 'nope' }, { status: 401 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await (
      login as unknown as { run: (ctx: { args: Record<string, unknown> }) => Promise<unknown> }
    ).run({ args: { email: 'a@x.com', 'password-stdin': true, json: true } })

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toMatchObject({ email: 'a@x.com', password: 'hunter2' })
  })
})

describe('the command runtime supplies --json', () => {
  // login had NO machine surface at all before the runtime — it is the first
  // command an agent runs, so its --json flag is load-bearing.
  it.each([
    ['login', login],
    ['dev', dev],
    ['test', test],
  ])('%s accepts --json', (_name, cmd) => {
    expect((cmd.args as Record<string, { type?: string }>).json?.type).toBe('boolean')
  })

  it('describes test output as a stream on stderr with stdout the single JSON line', () => {
    const description = (test.args as Record<string, { description?: string }>).json.description
    expect(description).toContain('Stream test output on stderr')
    expect(description).toContain('single-line JSON')
  })
})

describe('--env has the -e alias everywhere init does (ONB-7)', () => {
  it('init already has -e (baseline)', () => {
    expect((init.args as Record<string, { alias?: string }>).env.alias).toBe('e')
  })
  it('dev/deploy/test now match', () => {
    expect((dev.args as Record<string, { alias?: string }>).env.alias).toBe('e')
    expect((deploy.args as Record<string, { alias?: string }>).env.alias).toBe('e')
    expect((test.args as Record<string, { alias?: string }>).env.alias).toBe('e')
  })
})

describe('email/password failures carry actionable codes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('401 from the auth service → invalid_credentials, the server sentence, exit 1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
          { status: 401 },
        ),
      ),
    )
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    const command = login as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({
      args: { json: true, email: 'me@x.test', password: 'wrong', 'password-stdin': false },
    })
    expect(JSON.parse(lines[0])).toEqual({
      ok: false,
      code: 'invalid_credentials',
      error: 'Invalid email or password',
    })
    expect(process.exitCode).toBe(1)
  })

  it('429 from the auth service → rate_limited and the retry guidance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            code: 'TOO_MANY_SIGN_IN_ATTEMPTS',
            message: 'Too many sign-in attempts. Try again shortly.',
          },
          { status: 429, headers: { 'Retry-After': '60' } },
        ),
      ),
    )
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => lines.push(String(line)))
    const command = login as unknown as {
      run: (ctx: { args: Record<string, unknown> }) => Promise<unknown>
    }
    await command.run({
      args: { json: true, email: 'me@x.test', password: 'wrong', 'password-stdin': false },
    })
    expect(JSON.parse(lines[0])).toEqual({
      ok: false,
      code: 'rate_limited',
      error: 'Too many sign-in attempts. Try again shortly.',
    })
    expect(process.exitCode).toBe(1)
  })
})
