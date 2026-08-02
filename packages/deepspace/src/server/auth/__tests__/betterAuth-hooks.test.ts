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
) {
  return createDeepSpaceAuth({
    database: fakeD1,
    baseURL: 'https://auth.test.deep.space',
    secret: 'test-secret-at-least-32-characters-long',
    ...(onUserCreated ? { onUserCreated } : {}),
  })
}

type AfterHook = (
  user: { id: string; email: string; name: string },
  ctx: { request?: Request } | null,
) => Promise<void>

function afterHookOf(auth: ReturnType<typeof makeAuth>): AfterHook | undefined {
  const options = auth.options as {
    databaseHooks?: { user?: { create?: { after?: AfterHook } } }
  }
  return options.databaseHooks?.user?.create?.after
}

describe('createDeepSpaceAuth onUserCreated', () => {
  it('wires no databaseHooks when onUserCreated is absent', () => {
    expect(afterHookOf(makeAuth())).toBeUndefined()
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
