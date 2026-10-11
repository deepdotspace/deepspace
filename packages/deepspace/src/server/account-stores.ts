/**
 * One private store per account.
 *
 * For apps where each person's data is theirs alone (a task list, a
 * decision queue): every signed-in account gets its own RecordRoom and can
 * open only that one, so no query, permission rule or bug in the app can
 * show one account's records to another. The app owner's store is the app's
 * own room, `app:<app id>`, which the platform and owner-only tools already
 * use; every other account's store is `<prefix>:<user id>`, owned (admin) by
 * that account.
 *
 * Clients ask for `accountRoomId(userId)`; the WebSocket route, the agent
 * tool routes and any server code pick the store from the verified caller.
 *
 * ```ts
 * export const stores = accountStores({ prefix: 'tasks' })
 *
 * export class AppRecordRoom extends RecordRoom<Env> {
 *   constructor(state: DurableObjectState, env: Env) {
 *     super(state, env, schemas, { ownerUserId: stores.ownerOf(env, state.id.name) ?? undefined })
 *   }
 * }
 *
 * registerAccountStoreRoute(app, stores) // before registerRealtimeRoutes(app)
 * registerAgentToolRoutes(app, { buildTools, resolveAccess: stores.agentAccess(resolveAgentAuth) })
 * ```
 */

import type { Hono } from 'hono'
import { ACCOUNT_ROOM_PREFIX, accountRoomId } from '../shared/account-room'
import { authenticatedRoomRequest } from '../shared/room-identity-headers'
import { verifyJwt } from './auth/jwtVerifier'
import { resolveAppMembership } from './utils/app-role'
import type { AgentToolAccessResult } from './agent-tools'
import type { VerifyResult } from './auth/types'

export interface AccountStoreEnv {
  DEEPSPACE_APP_ID: string
  OWNER_USER_ID: string
}

export interface AccountStoreRouteEnv extends AccountStoreEnv {
  AUTH_JWT_PUBLIC_KEY: string
  AUTH_JWT_ISSUER: string
  RECORD_ROOMS: DurableObjectNamespace
}

export interface AccountStores {
  /** The store that holds `userId`'s data. */
  storeFor(env: AccountStoreEnv, userId: string): string
  /**
   * The store a verified caller may open for a requested room id, or null.
   * A caller may open only their own: `accountRoomId(theirId)`, or, for the
   * owner, the app room by its own name.
   */
  storeForRequest(env: AccountStoreEnv, requested: string, userId: string): string | null
  /** Who owns (is the only admin of) the named store; pass it as RecordRoom's `ownerUserId`. */
  ownerOf(env: AccountStoreEnv, storeName: string | undefined): string | null
  /**
   * A `resolveAccess` for registerAgentToolRoutes: a caller's agents act on
   * the caller's own store, and only once they are a member of it (their
   * first signed-in visit creates that).
   */
  agentAccess<Env extends AccountStoreEnv & { RECORD_ROOMS: DurableObjectNamespace }>(
    resolveIdentity: (request: Request, env: Env) => Promise<VerifyResult | null>,
  ): (request: Request, env: Env) => Promise<AgentToolAccessResult>
}

export function accountStores(options: { prefix: string }): AccountStores {
  if (!/^[a-z][a-z0-9-]*$/.test(options.prefix) || options.prefix === 'app' || `${options.prefix}:` === ACCOUNT_ROOM_PREFIX) {
    throw new Error(`accountStores: prefix "${options.prefix}" must be a lowercase word other than "app" and "me"`)
  }
  const accountPrefix = `${options.prefix}:`
  const appRoom = (env: AccountStoreEnv) => `app:${env.DEEPSPACE_APP_ID}`

  const storeFor = (env: AccountStoreEnv, userId: string) =>
    userId === env.OWNER_USER_ID ? appRoom(env) : `${accountPrefix}${userId}`

  return {
    storeFor,

    storeForRequest(env, requested, userId) {
      if (!userId) return null
      if (requested === accountRoomId(userId)) return storeFor(env, userId)
      if (requested === appRoom(env) && userId === env.OWNER_USER_ID) return appRoom(env)
      return null
    },

    ownerOf(env, storeName) {
      if (storeName === undefined) return null
      if (storeName === appRoom(env)) return env.OWNER_USER_ID
      if (!storeName.startsWith(accountPrefix)) return null
      const userId = storeName.slice(accountPrefix.length)
      // The owner's data lives in the app room, never in an account store.
      return userId && userId !== env.OWNER_USER_ID ? userId : null
    },

    agentAccess(resolveIdentity) {
      return async (request, env) => {
        const auth = await resolveIdentity(request, env)
        if (!auth?.userId) return { ok: false, status: 401 }
        const room = storeFor(env, auth.userId)
        const membership = await resolveAppMembership(env, auth.userId, request.signal, { room })
        // A read that could not complete is retryable, never a denial.
        if (!membership) return { ok: false, status: 503 }
        if (!membership.member) return { ok: false, status: 403 }
        return { ok: true, auth, room }
      }
    },
  }
}

/**
 * `GET /ws/:roomId`: a signed-in caller's connection to their own store.
 * No token is 401; asking for any store but one's own is 403. Identity in
 * the request is scrubbed; the room receives the verified identity only.
 *
 * Register it before any other `/ws/:roomId` route (the scaffold's
 * `registerRealtimeRoutes`): Hono runs the first match, and a generic room
 * route would open `me:<id>` as an ordinary room anyone could join.
 */
export function registerAccountStoreRoute<Env extends AccountStoreRouteEnv>(
  app: Hono<{ Bindings: Env }>,
  stores: AccountStores,
): void {
  app.get('/ws/:roomId', async (c) => {
    const token = new URL(c.req.url).searchParams.get('token')
    const { result: auth } = await verifyJwt(
      { publicKey: c.env.AUTH_JWT_PUBLIC_KEY, issuer: c.env.AUTH_JWT_ISSUER },
      token,
    )
    if (!auth) return new Response('Unauthorized', { status: 401 })
    const store = stores.storeForRequest(c.env, c.req.param('roomId'), auth.userId)
    if (!store) return new Response('Forbidden', { status: 403 })
    const stub = c.env.RECORD_ROOMS.get(c.env.RECORD_ROOMS.idFromName(store))
    return stub.fetch(authenticatedRoomRequest(c.req.raw, auth))
  })
}
