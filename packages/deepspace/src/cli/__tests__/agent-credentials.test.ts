import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const verifiedUntil = new Date(Date.now() + 86400000).toISOString()
let directory: string
beforeEach(() => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'ds-agent-credentials-'))
  vi.stubEnv('DEEPSPACE_ENV', 'staging')
  vi.stubEnv('DEEPSPACE_AUTH_URL', 'https://auth.deepspacesites.com')
  vi.stubEnv('DEEPSPACE_AGENT_CREDENTIAL_FILE', join(directory, 'credential.json'))
})
afterEach(() => {
  process.exitCode = 0
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(directory, { recursive: true, force: true })
})

it('uses the selected agent phrase for app tools without overwriting the management token', async () => {
  const api = await import('../agent-credentials')
  const credential = api.createAgentCredential('Muse')
  credential.token = jwt('agent_one')
  api.saveAgentCredential(credential)
  const before = readFileSync(join(directory, 'credential.json'), 'utf8')
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://auth.deepspacesites.com/api/auth/agents/app-token')
    expect(JSON.parse(init.body as string)).toEqual({ target: 'https://example.spacestest.com' })
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ' + credential.credential.replaceAll(' ', '-'),
    )
    return Response.json({ token: 'target-bound-token' })
  })
  vi.stubGlobal('fetch', fetch)
  const { mintAgentToken } = await import('../auth')
  expect(await mintAgentToken('https://example.spacestest.com')).toBe('target-bound-token')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(readFileSync(join(directory, 'credential.json'), 'utf8')).toBe(before)
})

it('preserves a pending renewal when refreshing the management token', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse')
  const pending = {
    id: 'renewal',
    prompt: 'Six times three?',
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    purpose: 'renew' as const,
  }
  value.pending = pending
  api.saveAgentCredential(value)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        userId: 'agent_one',
        token: jwt('agent_one'),
        verifiedUntil: verifiedUntil,
      }),
    ),
  )
  await api.ensureAgentToken(true)
  expect(api.readAgentCredential()?.pending).toEqual(pending)
  api.rememberAgentSession(
    api.readAgentCredential()!,
    {
      userId: 'agent_one',
      token: jwt('agent_one'),
      verifiedUntil: verifiedUntil,
    },
    'renew',
  )
  expect(api.readAgentCredential()?.pending).toBeUndefined()
})

it('recovers a server challenge with status and submits it without an extra issuance request', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse') // only the durable credential survived
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/status')
      ? Response.json({
          registered: false,
          status: 'registration_pending',
          name: 'Muse',
          challenge: {
            id: 'recover-me',
            prompt: 'Six times three?',
            purpose: 'register',
            state: 'pending',
            attemptsRemaining: 3,
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          },
        })
      : Response.json({
          registered: true,
          userId: 'agent_one',
          token: jwt('agent_one'),
          verifiedUntil: verifiedUntil,
        }),
  )
  vi.stubGlobal('fetch', fetch)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const command = (await import('../commands/agent-account')).default
    const commands = command.subCommands as Record<string, import('citty').CommandDef>
    await commands.status.run!({ args: { json: true } } as never)
    const output = JSON.parse(log.mock.calls.at(-1)![0])
    expect(output.nextStep.argvPrefix).toEqual([
      'deepspace',
      'auth',
      'agent',
      'register',
      '--json',
      '--answer',
    ])
    expect(output.action).toBeUndefined()
    expect(JSON.stringify(output)).not.toContain(value.credential)
    expect(api.readAgentCredential()?.pending?.id).toBe('recover-me')
    await commands.register.run!({ args: { json: true, answer: '18' } } as never)
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/auth/agents/status',
      '/api/auth/agents/register',
    ])
    expect(api.readAgentCredential()?.userId).toBe('agent_one')
    expect(api.readAgentCredential()?.pending).toBeUndefined()
  } finally {
    log.mockRestore()
  }
})

it('recovers a lost successful signup response by reusing the saved name and credential', async () => {
  const api = await import('../agent-credentials')
  api.createAgentCredential('Muse')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/challenges')
        ? Response.json(
            { code: 'agent_already_registered', error: 'Already registered.' },
            { status: 409 },
          )
        : Response.json({
            userId: 'agent_one',
            token: jwt('agent_one'),
            verifiedUntil: verifiedUntil,
          }),
    ),
  )
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const commands = (await import('../commands/agent-account')).default.subCommands as Record<
      string,
      import('citty').CommandDef
    >
    await commands.register.run!({ args: { json: true } } as never)
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ ok: true, userId: 'agent_one' })
    expect(api.readAgentCredential()?.name).toBe('Muse')
  } finally {
    log.mockRestore()
  }
})

it('reports an initialized credential when staging has no validated challenge', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          code: 'agent_challenges_unavailable',
          error: 'No validated challenges are available. Retry later.',
          recovery: 'wait',
        },
        { status: 503 },
      ),
    ),
  )
  const commands = (await import('../commands/agent-account')).default.subCommands as Record<
    string,
    import('citty').CommandDef
  >
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await commands.register.run!({ args: { name: 'Muse', json: true } } as never)
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
      ok: false,
      code: 'agent_challenges_unavailable',
      action: {
        argv: ['deepspace', 'auth', 'agent', 'register', '--name', 'Muse', '--json'],
      },
      credentialState: 'initialized',
      accountState: 'not_registered',
      retrySameCredential: true,
      recovery: 'wait',
    })
  } finally {
    log.mockRestore()
  }
  expect(api.readAgentCredential()).toEqual(value)
})

it('returns bounded retry and attempt metadata without forwarding arbitrary server fields', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          code: 'agent_rate_limited',
          error: 'Wait before retrying.',
          recovery: 'wait',
          token: 'do-not-print',
          credential: value.credential,
        },
        { status: 429, headers: { 'Retry-After': '60' } },
      ),
    ),
  )
  const limited = await api.agentRequest('status', value, undefined, 'GET').catch((error) => error)
  expect(limited.code).toBe('agent_rate_limited')
  expect(limited.action).toBeUndefined()
  expect(limited.extra).toEqual({ httpStatus: 429, retryAfterSeconds: 60, recovery: 'wait' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          code: 'incorrect_answer',
          error: 'Incorrect.',
          attemptsRemaining: 0,
          recovery: 'request-challenge',
        },
        { status: 400 },
      ),
    ),
  )
  await expect(api.agentRequest('renew', value)).rejects.toMatchObject({
    action: { argv: ['deepspace', 'auth', 'agent', 'renew', '--json'] },
    extra: { httpStatus: 400, attemptsRemaining: 0, recovery: 'request-challenge' },
  })
})
function jwt(sub: string, seconds = 900, claims: Record<string, unknown> = {}) {
  return `header.${Buffer.from(JSON.stringify({ sub, agentAccount: true, iss: 'https://auth.deepspacesites.com/api/auth', exp: Math.floor(Date.now() / 1000) + seconds, agentVerifiedUntil: Date.parse(verifiedUntil), ...claims })).toString('base64url')}.signature`
}

describe('portable agent credential', () => {
  it('writes before network access with private permissions and never replaces an existing identity', async () => {
    const api = await import('../agent-credentials')
    const first = api.createAgentCredential('Muse')
    expect(api.createAgentCredential('Other')).toEqual(first)
    expect(first.credential.split(' ')).toHaveLength(12)
    expect(statSync(api.agentCredentialPath()).mode & 0o777).toBe(0o600)
    expect(api.agentHash(first)).toHaveLength(64)
    expect(JSON.parse(readFileSync(api.agentCredentialPath(), 'utf8'))).toEqual(first)
  })
  it('refreshes from only the selected credential, caches tokens, and rejects changed identity', async () => {
    const api = await import('../agent-credentials')
    const value = api.createAgentCredential('Muse')
    const fetch = vi.fn(async () =>
      Response.json({
        userId: 'agent_one',
        token: jwt('agent_one'),
        verifiedUntil: verifiedUntil,
      }),
    )
    vi.stubGlobal('fetch', fetch)
    expect(await api.ensureAgentToken()).toBe(jwt('agent_one'))
    await api.ensureAgentToken()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]).toBeDefined()
    await api.ensureAgentToken(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(() =>
      api.rememberAgentSession(
        { ...value, userId: 'agent_one' },
        { userId: 'agent_two', token: jwt('agent_two'), verifiedUntil: new Date().toISOString() },
      ),
    ).toThrow('did not match')
  })
  it('fails closed without a selected agent file even if human auth exists', async () => {
    const { ensureToken, mintAgentToken } = await import('../auth')
    await expect(ensureToken()).rejects.toMatchObject({ code: 'agent_not_registered' })
    await expect(mintAgentToken('https://example.com')).rejects.toMatchObject({
      code: 'agent_credential_required',
    })
  })
  it('refuses production and auth overrides before writing or fetching', async () => {
    vi.stubEnv('DEEPSPACE_AUTH_URL', 'https://auth.deep.space')
    const api = await import('../agent-credentials')
    expect(() => api.createAgentCredential('Muse')).toThrow('staging prototype')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(api.ensureAgentToken()).rejects.toMatchObject({ code: 'agent_signup_disabled' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not put a durable credential into a network error', async () => {
    const api = await import('../agent-credentials')
    const value = api.createAgentCredential('Muse')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`unsafe ${value.credential}`)
      }),
    )
    await expect(api.agentRequest('token', value)).rejects.toMatchObject({
      code: 'network_error',
      extra: { serviceUrl: 'https://auth.deepspacesites.com', timeoutSeconds: 10 },
    })
    try {
      await api.agentRequest('token', value)
    } catch (error) {
      expect(String(error)).not.toContain(value.credential)
    }
  })
})

it('does not fall back to a human session when the selected file variable is empty', async () => {
  vi.stubEnv('DEEPSPACE_AGENT_CREDENTIAL_FILE', '')
  const { ensureToken } = await import('../auth')
  await expect(ensureToken()).rejects.toMatchObject({ code: 'agent_credential_file_required' })
  const { fetchRemoteTestAccounts } = await import('../lib/test-account-service')
  await expect(fetchRemoteTestAccounts()).rejects.toMatchObject({
    code: 'agent_capability_unavailable',
  })
})

it('status reports the selected agent identity without reading the human token cache', async () => {
  const api = await import('../agent-credentials')
  const identity = api.createAgentCredential('Muse')
  api.rememberAgentSession(identity, {
    token: jwt('agent_one'),
    userId: 'agent_one',
    verifiedUntil: verifiedUntil,
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const command = (await import('../commands/status')).default
    await command.run!({ args: { json: true } } as never)
    const output = JSON.parse(log.mock.calls.at(-1)![0])
    expect(output).toMatchObject({ accountType: 'agent', userId: 'agent_one', loggedIn: true })
    expect(JSON.stringify(output)).not.toContain(identity.credential)
  } finally {
    log.mockRestore()
  }
})

it('returns a runnable renewal action after verification expires', async () => {
  const api = await import('../agent-credentials')
  const identity = api.createAgentCredential('Muse')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { code: 'agent_verification_required', error: 'Renew verification.' },
        { status: 403 },
      ),
    ),
  )
  await expect(api.agentRequest('token', identity)).rejects.toMatchObject({
    code: 'agent_verification_required',
    action: { argv: ['deepspace', 'auth', 'agent', 'renew', '--json'] },
  })
})

it('explains how to answer the public challenge without emitting credentials or a placeholder action', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        status: 'challenge_required',
        challenge: {
          id: 'challenge-one',
          prompt: 'Six times three?',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      }),
    ),
  )
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const command = (await import('../commands/agent-account')).default
    const register = (command.subCommands as Record<string, import('citty').CommandDef>).register
    await register.run!({ args: { name: 'Muse', json: true } } as never)
    const output = JSON.parse(log.mock.calls.at(-1)![0])
    expect(output.nextStep).toMatchObject({
      kind: 'solve-challenge',
      argvPrefix: ['deepspace', 'auth', 'agent', 'register', '--json', '--answer'],
    })
    expect(output.action).toBeUndefined()
    expect(JSON.stringify(output)).not.toContain('dsa_')
    await register.run!({ args: { name: 'Muse', json: true, private: true } } as never)
    const privateOutput = JSON.parse(log.mock.calls.at(-1)![0])
    expect(privateOutput.nextStep.argvPrefix).toContain('--private')
  } finally {
    log.mockRestore()
  }
})

it('returns the same phrase for a private-chat receipt by default and can keep it in private storage', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse')
  value.userId = 'agent_one'
  api.saveAgentCredential(value)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        userId: 'agent_one',
        token: jwt('agent_one'),
        verifiedUntil: verifiedUntil,
      }),
    ),
  )
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const command = (await import('../commands/agent-account')).default
    const register = (command.subCommands as Record<string, import('citty').CommandDef>).register
    await register.run!({ args: { json: true } } as never)
    const receipt = JSON.parse(log.mock.calls.at(-1)![0])
    expect(receipt.accountReceipt.credential).toBe(value.credential)
    expect(receipt.accountReceipt.instruction).toContain('private chat')
    expect(receipt).not.toHaveProperty('token')
    await register.run!({ args: { json: true, private: true } } as never)
    const privateResult = JSON.parse(log.mock.calls.at(-1)![0])
    expect(privateResult).not.toHaveProperty('accountReceipt')
    expect(JSON.stringify(privateResult)).not.toContain(value.credential)
    expect(api.readAgentCredential()?.credential).toBe(value.credential)
  } finally {
    log.mockRestore()
  }
})

it('restores the same account from a chat phrase with no cached session', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse')
  const phrase = value.credential
  api.saveAgentCredential({ ...value, credential: phrase.toUpperCase().replaceAll(' ', ' \n ') })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      expect((options.headers as Record<string, string>).Authorization).toBe(
        'Bearer ' + phrase.replaceAll(' ', '-'),
      )
      return Response.json({
        userId: 'agent_one',
        token: jwt('agent_one'),
        verifiedUntil: verifiedUntil,
      })
    }),
  )
  expect(await api.ensureAgentToken()).toBe(jwt('agent_one'))
  expect(api.readAgentCredential()?.credential).toBe(phrase)
  expect(api.readAgentCredential()?.userId).toBe('agent_one')
})

it('rejects malformed auth responses without losing the stored identity', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse')
  for (const response of [null, [], 'not an object']) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(response)),
    )
    await expect(api.agentRequest('token', value)).rejects.toMatchObject({
      code: 'invalid_response',
    })
  }
  expect(api.readAgentCredential()).toEqual(value)
})

it('refreshes app-scoped or invalid cached JWTs and refuses to save them as management sessions', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse')
  const invalidTokens = [
    jwt('agent_one', 900, { scope: 'app:example', app_name: 'example' }),
    jwt('agent_one', 900, { agentVerifiedUntil: 0 }),
    jwt('agent_one', -1),
    'malformed',
  ]
  for (const token of invalidTokens) {
    api.saveAgentCredential({ ...value, userId: 'agent_one', token, verifiedUntil })
    const fetch = vi.fn(async () =>
      Response.json({ userId: 'agent_one', token: jwt('agent_one'), verifiedUntil }),
    )
    vi.stubGlobal('fetch', fetch)
    expect(await api.ensureAgentToken()).toBe(jwt('agent_one'))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(() =>
      api.rememberAgentSession(value, { userId: 'agent_one', token, verifiedUntil }),
    ).toThrow('did not match')
  }
  expect(() =>
    api.rememberAgentSession(value, {
      userId: 'agent_one',
      token: jwt('agent_one'),
      verifiedUntil: 'invalid',
    }),
  ).toThrow('did not match')
})

it('retains private receipt preference through an expired challenge and status recovery', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse')
  value.pending = {
    id: 'expired',
    purpose: 'register',
    prompt: 'Six times three?',
    expiresAt: new Date(0).toISOString(),
  }
  api.saveAgentCredential(value)
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/status')
      ? Response.json({ registered: false, challenge: { ...value.pending, state: 'expired' } })
      : Response.json(
          { code: 'challenge_expired', error: 'Request another challenge.' },
          { status: 410 },
        ),
  )
  vi.stubGlobal('fetch', fetch)
  const commands = (await import('../commands/agent-account')).default.subCommands as Record<
    string,
    import('citty').CommandDef
  >
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await commands.register.run!({ args: { json: true, answer: '18', private: true } } as never)
    expect(JSON.parse(log.mock.calls.at(-1)![0]).action.argv).toContain('--private')
    expect(api.readAgentCredential()?.privateReceipt).toBe(true)
    await commands.status.run!({ args: { json: true } } as never)
    expect(JSON.parse(log.mock.calls.at(-1)![0]).action.argv).toContain('--private')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ userId: 'agent_one', token: jwt('agent_one'), verifiedUntil }),
      ),
    )
    await commands.register.run!({ args: { json: true, answer: '18' } } as never)
    expect(JSON.parse(log.mock.calls.at(-1)![0])).not.toHaveProperty('accountReceipt')
    await commands.register.run!({ args: { json: true, private: false } } as never)
    expect(JSON.parse(log.mock.calls.at(-1)![0]).accountReceipt.credential).toBe(value.credential)
  } finally {
    log.mockRestore()
  }
})

it('keeps renewal instructions free of registration-only receipt flags', async () => {
  const api = await import('../agent-credentials')
  const value = api.createAgentCredential('Muse')
  api.saveAgentCredential({ ...value, privateReceipt: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        challenge: {
          id: 'renew',
          purpose: 'renew',
          state: 'pending',
          prompt: 'Six times three?',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      }),
    ),
  )
  const commands = (await import('../commands/agent-account')).default.subCommands as Record<
    string,
    import('citty').CommandDef
  >
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await commands.renew.run!({ args: { json: true } } as never)
    expect(JSON.parse(log.mock.calls.at(-1)![0]).nextStep.argvPrefix).toEqual([
      'deepspace',
      'auth',
      'agent',
      'renew',
      '--json',
      '--answer',
    ])
  } finally {
    log.mockRestore()
  }
})
