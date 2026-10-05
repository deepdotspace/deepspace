/**
 * createDeepSpaceAuth onUserCreated wiring.
 *
 * Verifies the observer hook is exposed through better-auth's
 * databaseHooks.user.create.after, and that a throwing observer is swallowed
 * (better-auth awaits `after` hooks inline before responding, so an exception
 * here would fail the signup itself).
 */

import { describe, expect, it, vi } from 'vitest'
import { createDeepSpaceAuth } from '../betterAuth'

// betterAuth() kicks off adapter detection in the background even though we
// only inspect .options. The stub carries `aggregate` + `prepare` so
// better-auth's getKyselyDatabaseType classifies it as sqlite and wraps it in
// a (lazy, never-queried) SqliteDialect instead of rejecting with
// "Failed to initialize database adapter" as an unhandled rejection.
const fakeD1 = { aggregate: () => ({}), prepare: () => ({}) } as unknown as D1Database

function makeAuth(
  onUserCreated?: (
    user: { id: string; email: string; name: string },
    ctx: { request?: Request } | null,
  ) => Promise<void>,
  options: Pick<
    Parameters<typeof createDeepSpaceAuth>[0],
    'beforeUserCreate' | 'userAdditionalFields'
  > = {},
) {
  return createDeepSpaceAuth({
    database: fakeD1,
    baseURL: 'https://auth.test.deep.space',
    secret: 'test-secret-at-least-32-characters-long',
    ...(onUserCreated ? { onUserCreated } : {}),
    ...options,
  })
}

type AfterHook = (
  user: { id: string; email: string; name: string },
  ctx: { request?: Request } | null,
) => Promise<void>

type BeforeHook = (
  user: { id: string; email: string; name: string },
  ctx: { request?: Request } | null,
) => Promise<unknown>

function afterHookOf(auth: ReturnType<typeof makeAuth>): AfterHook | undefined {
  const options = auth.options as {
    databaseHooks?: { user?: { create?: { after?: AfterHook } } }
  }
  return options.databaseHooks?.user?.create?.after
}

function beforeHookOf(auth: ReturnType<typeof makeAuth>): BeforeHook | undefined {
  const options = auth.options as {
    databaseHooks?: { user?: { create?: { before?: BeforeHook } } }
  }
  return options.databaseHooks?.user?.create?.before
}

describe('createDeepSpaceAuth onUserCreated', () => {
  it('wires no databaseHooks when onUserCreated is absent', () => {
    expect(afterHookOf(makeAuth())).toBeUndefined()
  })

  it('declares optional server-owned fields and wires a before-create callback', async () => {
    const beforeUserCreate = vi.fn().mockResolvedValue({
      data: { signupReferral: '{"v":1}' },
    })
    const auth = makeAuth(undefined, {
      userAdditionalFields: {
        signupReferral: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
          fieldName: 'signup_referral',
        },
      },
      beforeUserCreate,
    })

    expect(auth.options.user?.additionalFields?.signupReferral).toMatchObject({
      input: false,
      returned: false,
      fieldName: 'signup_referral',
    })
    const before = beforeHookOf(auth)
    const user = { id: 'user_ref', email: 'ref@example.com', name: 'Ref' }
    // A direct unit invocation has no Better Auth request-local state. The
    // auth-worker integration suite exercises this wrapper inside the real
    // OAuth callback and verifies the decrypted state reaches the callback.
    await expect(before!(user, null)).resolves.toEqual({
      data: { signupReferral: '{"v":1}' },
    })
    expect(beforeUserCreate).toHaveBeenCalledWith(user, null)
  })

  it('keeps before-create failures fatal while the after observer remains isolated', async () => {
    const beforeUserCreate = vi.fn().mockRejectedValue(new Error('invalid referral context'))
    const onUserCreated = vi.fn().mockResolvedValue(undefined)
    const auth = makeAuth(onUserCreated, { beforeUserCreate })

    await expect(
      beforeHookOf(auth)!({ id: 'user_bad', email: 'bad@example.com', name: 'Bad' }, null),
    ).rejects.toThrow('invalid referral context')
    expect(afterHookOf(auth)).toBeTypeOf('function')
  })

  it('invokes the callback with the created user and endpoint context', async () => {
    const onUserCreated = vi.fn().mockResolvedValue(undefined)
    const after = afterHookOf(makeAuth(onUserCreated))
    expect(after).toBeTypeOf('function')

    const user = { id: 'user_1', email: 'new@example.com', name: 'New User' }
    const request = new Request('https://auth.test.deep.space/api/auth/callback/google', {
      headers: { cookie: '_gcl_aw=GCL.1700000000.TestGclid123' },
    })
    await after!(user, { request })

    expect(onUserCreated).toHaveBeenCalledTimes(1)
    expect(onUserCreated).toHaveBeenCalledWith(user, { request })
  })

  it('forwards standalone ctx.headers when no request is present', async () => {
    const onUserCreated = vi.fn().mockResolvedValue(undefined)
    const after = afterHookOf(makeAuth(onUserCreated))
    const headers = new Headers({ cookie: '_ds_gclid=TestGclid_0001' })
    await after!({ id: 'user_h', email: 'h@example.com', name: 'H' }, { headers } as never)
    expect(onUserCreated).toHaveBeenCalledWith(
      { id: 'user_h', email: 'h@example.com', name: 'H' },
      { request: undefined, headers },
    )
  })

  it('passes null context through for server-side creations', async () => {
    const onUserCreated = vi.fn().mockResolvedValue(undefined)
    const after = afterHookOf(makeAuth(onUserCreated))
    await after!({ id: 'user_2', email: 'srv@example.com', name: 'Srv' }, null)
    expect(onUserCreated).toHaveBeenCalledWith(
      { id: 'user_2', email: 'srv@example.com', name: 'Srv' },
      null,
    )
  })

  it('swallows a throwing callback so signup is unaffected', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const onUserCreated = vi.fn().mockRejectedValue(new Error('boom'))
      const after = afterHookOf(makeAuth(onUserCreated))
      await expect(
        after!({ id: 'user_3', email: 'x@example.com', name: 'X' }, null),
      ).resolves.toBeUndefined()
      expect(consoleError).toHaveBeenCalledOnce()
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('createDeepSpaceAuth OAuth error page', () => {
  it('sends unattributable OAuth failures to the configured page', () => {
    const auth = createDeepSpaceAuth({
      database: fakeD1,
      baseURL: 'https://auth.example',
      secret: 'test-secret-at-least-32-characters-long',
      errorURL: 'https://auth.example/login/social/error',
    })
    expect(auth.options.onAPIError?.errorURL).toBe('https://auth.example/login/social/error')
    const plain = createDeepSpaceAuth({
      database: fakeD1,
      baseURL: 'https://auth.example',
      secret: 'test-secret-at-least-32-characters-long',
    })
    expect(plain.options.onAPIError).toBeUndefined()
  })
})
