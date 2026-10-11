import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { accountRoomId } from '../../shared/account-room'
import { accountStores, registerAccountStoreRoute, type AccountStoreRouteEnv } from '../account-stores'

vi.mock('../auth/jwtVerifier', () => ({
  // The token is the user id; 'bad' fails verification.
  verifyJwt: async (_config: unknown, token: string | null) => ({
    result: token && token !== 'bad' ? { userId: token, claims: { sub: token } } : null,
  }),
}))

const env = { DEEPSPACE_APP_ID: 'app_TEST', OWNER_USER_ID: 'owner' }
const stores = accountStores({ prefix: 'tasks' })

describe('accountStores', () => {
  it('gives the owner the app room and every other account its own store', () => {
    expect(stores.storeFor(env, 'owner')).toBe('app:app_TEST')
    expect(stores.storeFor(env, 'alice')).toBe('tasks:alice')
    expect(stores.storeFor(env, 'bob')).not.toBe(stores.storeFor(env, 'alice'))
  })

  it('opens only the caller’s own store', () => {
    expect(stores.storeForRequest(env, accountRoomId('alice'), 'alice')).toBe('tasks:alice')
    expect(stores.storeForRequest(env, accountRoomId('owner'), 'owner')).toBe('app:app_TEST')
    expect(stores.storeForRequest(env, 'app:app_TEST', 'owner')).toBe('app:app_TEST')

    expect(stores.storeForRequest(env, accountRoomId('owner'), 'alice')).toBeNull()
    expect(stores.storeForRequest(env, 'app:app_TEST', 'alice')).toBeNull()
    expect(stores.storeForRequest(env, 'tasks:bob', 'alice')).toBeNull()
    expect(stores.storeForRequest(env, 'tasks:alice', 'alice')).toBeNull()
    expect(stores.storeForRequest(env, accountRoomId(''), '')).toBeNull()
  })

  it('names each store’s only admin', () => {
    expect(stores.ownerOf(env, 'app:app_TEST')).toBe('owner')
    expect(stores.ownerOf(env, 'tasks:alice')).toBe('alice')
    expect(stores.ownerOf(env, 'tasks:owner')).toBeNull()
    expect(stores.ownerOf(env, 'tasks:')).toBeNull()
    expect(stores.ownerOf(env, 'app:other')).toBeNull()
    expect(stores.ownerOf(env, undefined)).toBeNull()
  })

  it('refuses prefixes that collide with the app or client rooms', () => {
    for (const prefix of ['app', 'me', 'Tasks', 'tasks:', '']) {
      expect(() => accountStores({ prefix })).toThrow()
    }
  })

  it('grants agents the caller’s own store once they are a member', async () => {
    const memberOf = new Set(['tasks:alice'])
    const roomsEnv = {
      ...env,
      RECORD_ROOMS: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          fetch: async () =>
            Response.json(
              memberOf.has(name)
                ? { success: true, data: { record: { data: { role: 'member' } } } }
                : { success: false, error: 'Record not found: users' },
            ),
        }),
      } as unknown as DurableObjectNamespace,
    }
    const access = stores.agentAccess(async (request: Request) => {
      const user = request.headers.get('x-user')
      return user ? { userId: user, claims: { sub: user } } as never : null
    })
    const as = (user?: string) => new Request('https://app.test/', { headers: user ? { 'x-user': user } : {} })

    await expect(access(as(), roomsEnv)).resolves.toEqual({ ok: false, status: 401 })
    await expect(access(as('owner'), roomsEnv)).resolves.toMatchObject({ ok: true, room: 'app:app_TEST' })
    await expect(access(as('alice'), roomsEnv)).resolves.toMatchObject({ ok: true, room: 'tasks:alice' })
    await expect(access(as('bob'), roomsEnv)).resolves.toEqual({ ok: false, status: 403 })
  })
})

describe('registerAccountStoreRoute', () => {
  function harness() {
    const opened: string[] = []
    const app = new Hono<{ Bindings: AccountStoreRouteEnv }>()
    registerAccountStoreRoute(app, stores)
    const routeEnv: AccountStoreRouteEnv = {
      ...env,
      AUTH_JWT_PUBLIC_KEY: 'key',
      AUTH_JWT_ISSUER: 'issuer',
      RECORD_ROOMS: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          fetch: async () => {
            opened.push(name)
            return new Response('opened')
          },
        }),
      } as unknown as DurableObjectNamespace,
    }
    const get = (room: string, token?: string) =>
      app.request(`/ws/${encodeURIComponent(room)}${token ? `?token=${token}` : ''}`, {}, routeEnv)
    return { opened, get }
  }

  it('connects a signed-in caller to their own store only', async () => {
    const { opened, get } = harness()
    expect((await get(accountRoomId('alice'), 'alice')).status).toBe(200)
    expect(opened).toEqual(['tasks:alice'])

    expect((await get(accountRoomId('bob'), 'alice')).status).toBe(403)
    expect((await get(accountRoomId('alice'))).status).toBe(401)
    expect((await get(accountRoomId('alice'), 'bad')).status).toBe(401)
    expect(opened).toEqual(['tasks:alice'])
  })
})
