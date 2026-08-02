/**
 * WebSocket routing for app-owned Durable Objects.
 *
 * Caller identity in query parameters is never trusted. Generic routes scrub
 * it and derive identity from a verified JWT; the documents-aware Yjs route
 * additionally resolves an application role from the documents collection.
 */

import type { Context, Hono } from 'hono'
import { verifyJwt } from 'deepspace/worker'
import type { JwtVerifierConfig, VerifyResult } from 'deepspace/worker'
import type { AppContext, Env } from '../../worker.js'

function jwtConfig(env: Env): JwtVerifierConfig {
  return { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER }
}

const IDENTITY_QUERY_PARAMS = ['userId', 'userName', 'userEmail', 'userImageUrl', 'role'] as const

function authenticatedRoomUrl(
  requestUrl: string,
  auth: VerifyResult | null,
  extraParams?: (auth: VerifyResult) => Record<string, string>,
): URL {
  const doUrl = new URL(requestUrl)
  doUrl.searchParams.delete('token')
  for (const key of IDENTITY_QUERY_PARAMS) {
    doUrl.searchParams.delete(key)
  }

  if (!auth) return doUrl

  doUrl.searchParams.set('userId', auth.userId)
  if (auth.claims.name) doUrl.searchParams.set('userName', auth.claims.name)
  if (auth.claims.email) doUrl.searchParams.set('userEmail', auth.claims.email)
  if (auth.claims.image) doUrl.searchParams.set('userImageUrl', auth.claims.image)
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams(auth))) {
      doUrl.searchParams.set(key, value)
    }
  }
  return doUrl
}

function wsRoute(
  doNamespace: (env: Env) => DurableObjectNamespace,
  extraParams?: (auth: VerifyResult) => Record<string, string>,
) {
  return async (c: Context<AppContext>) => {
    const id = c.req.param('roomId') ?? c.req.param('docId') ?? c.req.param('scopeId')
    if (!id) return new Response('Not found', { status: 404 })
    const url = new URL(c.req.url)
    const token = url.searchParams.get('token')

    let auth: VerifyResult | null = null
    if (token) {
      auth = (await verifyJwt(jwtConfig(c.env), token)).result
      if (!auth) return new Response('Unauthorized', { status: 401 })
    }

    const doUrl = authenticatedRoomUrl(c.req.url, auth, extraParams)

    const namespace = doNamespace(c.env)
    const stub = namespace.get(namespace.idFromName(id))
    return stub.fetch(new Request(doUrl.toString(), c.req.raw))
  }
}

type DocsYjsRole = 'admin' | 'member' | 'viewer'

interface DocumentRecordForAccess {
  ownerId?: string
  collaborators?: string
  editors?: string
}

type DocumentAccessLookup =
  | { kind: 'found'; doc: DocumentRecordForAccess }
  | { kind: 'not-docs-room' }
  | { kind: 'error' }

function parseAccessList(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

async function getDocumentForAccess(env: Env, docId: string): Promise<DocumentAccessLookup> {
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
  try {
    const res = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': env.OWNER_USER_ID,
          'X-App-Action': 'true',
        },
        body: JSON.stringify({
          tool: 'records.get',
          params: { collection: 'documents', recordId: docId },
        }),
      }),
    )
    const json = (await res.json()) as {
      success?: boolean
      error?: string
      data?: { record?: { data?: DocumentRecordForAccess } }
    }
    if (json.success && json.data?.record?.data) {
      return { kind: 'found', doc: json.data.record.data }
    }
    if (
      json.error === 'Record not found' ||
      json.error?.startsWith('Schema not registered for collection: documents')
    ) {
      return { kind: 'not-docs-room' }
    }
    return { kind: 'error' }
  } catch {
    return { kind: 'error' }
  }
}

async function resolveDocsYjsRole(
  env: Env,
  docId: string,
  userId: string,
): Promise<DocsYjsRole | null> {
  const lookup = await getDocumentForAccess(env, docId)
  if (lookup.kind === 'not-docs-room') return 'member'
  if (lookup.kind === 'error') return null
  const { doc } = lookup
  if (doc.ownerId === userId || userId === env.OWNER_USER_ID) return 'admin'

  const editors = parseAccessList(doc.editors)
  if (editors.includes(userId)) return 'member'

  const collaborators = parseAccessList(doc.collaborators)
  if (collaborators.includes(userId)) return 'viewer'

  return null
}

export function registerRealtimeRoutes(app: Hono<AppContext>): void {
  app.get(
    '/ws/:roomId',
    wsRoute((env) => env.RECORD_ROOMS),
  )

  app.get('/ws/yjs/:docId', async (c) => {
    const docId = c.req.param('docId')
    const url = new URL(c.req.url)
    const token = url.searchParams.get('token')
    const auth = token ? (await verifyJwt(jwtConfig(c.env), token)).result : null
    if (!auth) return new Response('Unauthorized', { status: 401 })

    const role = await resolveDocsYjsRole(c.env, docId, auth.userId)
    if (!role) return new Response('Forbidden', { status: 403 })

    const doUrl = authenticatedRoomUrl(c.req.url, auth, () => ({ role }))

    const stub = c.env.YJS_ROOMS.get(c.env.YJS_ROOMS.idFromName(docId))
    return stub.fetch(new Request(doUrl.toString(), c.req.raw))
  })

  app.get(
    '/ws/canvas/:docId',
    wsRoute(
      (env) => env.CANVAS_ROOMS,
      () => ({ role: 'member' }),
    ),
  )

  app.get(
    '/ws/presence/:scopeId',
    // name/email/image are already forwarded for every authenticated room.
    wsRoute((env) => env.PRESENCE_ROOMS),
  )

  app.get(
    '/ws/cron/:roomId',
    wsRoute(
      (env) => env.CRON_ROOMS,
      // Authenticated users can trigger/pause/resume. Anonymous connections
      // have no role and CronRoom enforces them as read-only viewers.
      () => ({ role: 'member' }),
    ),
  )

  app.get(
    '/ws/jobs/:roomId',
    wsRoute((env) => env.JOB_ROOMS),
  )
}
