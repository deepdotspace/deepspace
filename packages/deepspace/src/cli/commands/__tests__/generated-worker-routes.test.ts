import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import { asSchema, tool } from 'ai'
import type { ToolSet } from 'ai'
import { importPKCS8, SignJWT } from 'jose'
import { z } from 'zod/v4'
import { assembleTemplate, TEMPLATES_DIR } from './template-assembly'
import { resolveDeployRunWorkerFirst } from '../deploy/build'
import {
  isAssetNotFoundHandling,
  isPlatformReservedPath,
  REQUIRED_COMPATIBILITY_FLAGS,
  resolveCompatibilityFlags,
  SDK_RUN_WORKER_FIRST,
} from '../../../shared/app-routing'
import { BROWSER_PROXY_ROUTES } from '../../../shared/platform-proxy'
import { decodeRoomIdentityHeader } from '../../../shared/room-identity-headers'

interface TestEnv {
  ASSETS?: Fetcher
  APP_NAME?: string
  AUTH_JWT_ISSUER?: string
  AUTH_JWT_PUBLIC_KEY?: string
  AUTH_WORKER_URL?: string
  DEEPSPACE_APP_ID?: string
  OWNER_USER_ID?: string
  ALLOW_DEBUG_ROUTES?: string
  RECORD_ROOMS?: DurableObjectNamespace
  YJS_ROOMS?: DurableObjectNamespace
  CANVAS_ROOMS?: DurableObjectNamespace
}

type TestContext = { Bindings: TestEnv }
type RegisterRoutes = (app: Hono<TestContext>) => void
type RegisterAuthenticatedRoutes = (
  app: Hono<TestContext>,
  resolveAuth: () => Promise<null>,
) => void

let registerActionRoutes: RegisterAuthenticatedRoutes
let registerAgent: (
  app: Hono<TestContext>,
  options: {
    tools: (
      executor: (toolName: string, params: Record<string, unknown>) => Promise<unknown>,
    ) => ToolSet
    inApp?: boolean
    local?: boolean
    authorize?: (context: { userId: string }) => boolean | Promise<boolean>
  },
) => void
let buildGeneratedTools: (
  executor: (toolName: string, params: Record<string, unknown>) => Promise<unknown>,
) => ToolSet
let registerAuthAndIntegrationRoutes: RegisterRoutes
let registerPlatformProxyRoutes: RegisterRoutes
let registerRealtimeRoutes: RegisterRoutes
let registerStaticRoutes: RegisterRoutes
let agentTemplateDir: string

beforeAll(async () => {
  // A computed file URL keeps generated-app sources outside this package's
  // TypeScript rootDir while Vitest still executes the real modules.
  const serverDirectory = join(TEMPLATES_DIR, 'base', 'src', 'server')
  const actionRoutes = await import(pathToFileURL(join(serverDirectory, 'action-routes.ts')).href)
  // Keep the assembled copy under this package so its `deepspace/*` imports
  // resolve through the package's self-reference during Vitest execution.
  agentTemplateDir = mkdtempSync(join(process.cwd(), '.tmp-ds-agent-routes-'))
  assembleTemplate('copilot', join(agentTemplateDir, 'app'))
  const agentRoutes = await import(
    pathToFileURL(join(agentTemplateDir, 'app', 'src', 'ai', 'agent.ts')).href
  )
  const generatedTools = await import(
    pathToFileURL(join(agentTemplateDir, 'app', 'src', 'ai', 'tools.ts')).href
  )
  const httpRoutes = await import(pathToFileURL(join(serverDirectory, 'http-routes.ts')).href)
  const realtimeRoutes = await import(
    pathToFileURL(join(serverDirectory, 'realtime-routes.ts')).href
  )

  registerActionRoutes = actionRoutes.registerActionRoutes as RegisterAuthenticatedRoutes
  registerAgent = agentRoutes.registerAgent as typeof registerAgent
  buildGeneratedTools = generatedTools.buildTools as typeof buildGeneratedTools
  registerAuthAndIntegrationRoutes = httpRoutes.registerAuthAndIntegrationRoutes as RegisterRoutes
  registerPlatformProxyRoutes = httpRoutes.registerPlatformProxyRoutes as RegisterRoutes
  registerStaticRoutes = httpRoutes.registerStaticRoutes as RegisterRoutes
  registerRealtimeRoutes = realtimeRoutes.registerRealtimeRoutes as RegisterRoutes
})

afterAll(() => {
  rmSync(agentTemplateDir, { recursive: true, force: true })
})

function env(bindings: TestEnv = {}): TestEnv {
  return bindings
}

const TEST_JWT_ISSUER = 'https://auth.test.deep.space'
const TEST_JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHdCNTlzfguOe6KiVagYksU5ZTrQ2
9qMZbXQJesZQOsFR7tdd4qSBuVzv+ZhxOdYmDwGbcCyA+9gdTpdqqFxEOw==
-----END PUBLIC KEY-----`
const TEST_JWT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgViVa+AqStZtvZ49N
7VVjclAPZuJ3TmQQDeRAiamBxPKhRANCAAQd0I1OXN+C457oqJVqBiSxTllOtDb2
oxltdAl6xlA6wVHu113ipIG5XO/5mHE51iYPAZtwLID72B1Ol2qoXEQ7
-----END PRIVATE KEY-----`

async function signTestJwt(subject = 'verified-user'): Promise<string> {
  const privateKey = await importPKCS8(TEST_JWT_PRIVATE_KEY, 'ES256')
  return new SignJWT({
    name: '你好 👋\nSecond line',
    email: 'verified@example.test',
    image: 'https://images.example.test/verified.png',
  })
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(subject)
    .setIssuer(TEST_JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

async function signAgentJwt(
  target: string,
  subject = 'verified-user',
  expiresIn = '5m',
): Promise<string> {
  const privateKey = await importPKCS8(TEST_JWT_PRIVATE_KEY, 'ES256')
  return new SignJWT({
    scope: 'agent',
    name: 'Agent user',
    email: 'agent@example.test',
  })
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(subject)
    .setIssuer(`${TEST_JWT_ISSUER}/agent`)
    .setAudience(target)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey)
}

const APP_SHELL = '<!doctype html><div id="root"></div>'

/**
 * The asset layer AS THE PLATFORM CONFIGURES IT.
 *
 * Deploys set `not_found_handling: "none"`, so the binding serves the files it
 * has and answers a miss with a real 404 — it never invents the shell. The
 * previous fake here modelled the OPPOSITE of the config we shipped (a 404 on
 * a miss while production returned the shell at 200), which is how this suite
 * certified route handling that could not run. Keep this in step with
 * `cloudflare-deploy.ts`: a double that disagrees with the platform is worse
 * than no double at all.
 */
function spaAssetLayer(present: Record<string, [body: string, contentType: string]> = {}): {
  assets: Fetcher
  assetRequests: string[]
} {
  const assetRequests: string[] = []
  const assets = {
    async fetch(request: Request) {
      const pathname = new URL(request.url).pathname
      assetRequests.push(pathname)
      // `html_handling: "auto-trailing-slash"` serves index files at their
      // bare path and REDIRECTS the explicit filename there. Modelling that
      // is what catches a worker handing a browser a 307 off the URL it
      // asked for.
      if (pathname === '/index.html') {
        return new Response(null, { status: 307, headers: { location: '/' } })
      }
      const hit =
        present[pathname] ?? (pathname === '/' ? ([APP_SHELL, 'text/html'] as const) : undefined)
      if (hit) {
        return new Response(hit[0], { status: 200, headers: { 'content-type': hit[1] } })
      }
      return new Response(null, { status: 404 })
    },
  } as Fetcher
  return { assets, assetRequests }
}

describe('generated worker route owners', () => {
  it('advertises free-form record objects without weakening input validation', async () => {
    const tools = buildGeneratedTools(async () => ({ success: true }))
    const createSchema = asSchema(tools.records_create.inputSchema)
    const querySchema = asSchema(tools.records_query.inputSchema)

    // Free-form record params must advertise an open object (`{}` is the
    // any-value schema); a closed `additionalProperties: false` would tell
    // the model the objects are empty.
    expect(createSchema.jsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['collection', 'data'],
      properties: {
        data: { type: 'object', additionalProperties: {} },
      },
    })
    expect(querySchema.jsonSchema).toMatchObject({
      properties: {
        where: { type: 'object', additionalProperties: {} },
      },
    })

    await expect(
      createSchema.validate?.({ collection: 'notes', data: { title: 'Hello' } }),
    ).resolves.toMatchObject({ success: true })
    await expect(createSchema.validate?.({ collection: 'notes' })).resolves.toMatchObject({
      success: false,
    })
  })

  it('shares the owner/member gate between website AI and local assistant tools', async () => {
    interface RoomCall {
      request: Request
      body: { tool?: string; params?: { collection?: string; recordId?: string } }
    }
    const roomCalls: RoomCall[] = []
    let memberActive = true
    const rooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          const body = (await request.clone().json()) as RoomCall['body']
          roomCalls.push({ request, body })
          if (body.tool === 'records.get' && body.params?.collection === 'users') {
            return Response.json(
              memberActive
                ? { success: true, data: { record: { data: { role: 'editor' } } } }
                : { success: false, error: 'Record not found' },
            )
          }
          return Response.json({ success: true, data: { echoed: body } })
        },
      }),
    } as unknown as DurableObjectNamespace
    const app = new Hono<TestContext>()
    registerAgent(app, {
      tools: (executor) => ({
        echo: tool({
          description: 'Echoes a value through the app tool executor.',
          inputSchema: z.object({ value: z.string() }),
          execute: ({ value }) => executor('records.query', { value }),
        }),
      }),
    })
    const bindings = env({
      APP_NAME: 'Test app',
      AUTH_JWT_ISSUER: TEST_JWT_ISSUER,
      AUTH_JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY,
      DEEPSPACE_APP_ID: 'app_test',
      OWNER_USER_ID: 'owner-user',
      RECORD_ROOMS: rooms,
    })

    const signedOut = await app.request(
      'https://app.test/_deepspace/agent/tools',
      undefined,
      bindings,
    )
    expect(signedOut.status).toBe(401)

    const ordinaryMemberToken = await signTestJwt('member-user')
    const ordinaryAtAgentRoute = await app.request(
      'https://app.test/_deepspace/agent/tools',
      { headers: { Authorization: `Bearer ${ordinaryMemberToken}` } },
      bindings,
    )
    expect(ordinaryAtAgentRoute.status).toBe(401)

    const memberToken = await signAgentJwt('https://app.test', 'member-user')
    const discovered = await app.request(
      'https://app.test/_deepspace/agent/tools',
      { headers: { Authorization: `Bearer ${memberToken}` } },
      bindings,
    )
    expect(discovered.status).toBe(200)
    const listedTools = ((await discovered.json()) as { tools: Array<{ name: string }> }).tools
    expect(listedTools).toHaveLength(1)
    expect(listedTools[0]?.name).toBe('echo')

    const invoked = await app.request(
      'https://app.test/_deepspace/agent/tools/echo',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { value: 'hello' } }),
      },
      bindings,
    )
    expect(invoked.status).toBe(200)

    const wrongTarget = await app.request(
      'https://other.test/_deepspace/agent/tools',
      { headers: { Authorization: `Bearer ${memberToken}` } },
      bindings,
    )
    expect(wrongTarget.status).toBe(401)

    const expired = await app.request(
      'https://app.test/_deepspace/agent/tools',
      {
        headers: {
          Authorization: `Bearer ${await signAgentJwt('https://app.test', 'member-user', '-10s')}`,
        },
      },
      bindings,
    )
    expect(expired.status).toBe(401)

    memberActive = false
    const revoked = await app.request(
      'https://app.test/_deepspace/agent/tools',
      { headers: { Authorization: `Bearer ${memberToken}` } },
      bindings,
    )
    expect(revoked.status).toBe(403)

    expect(roomCalls).toHaveLength(4)
    // Membership is the shared owner-context read of the caller's users row
    // (the same primitive that gates admin and realtime routes)...
    const membershipReads = roomCalls.filter(({ body }) => body.tool === 'records.get')
    expect(membershipReads).toHaveLength(3)
    expect(
      membershipReads.every(
        ({ request, body }) =>
          request.headers.get('X-App-Action') === 'true' &&
          request.headers.get('X-User-Id') === 'owner-user' &&
          body.params?.recordId === 'member-user',
      ),
    ).toBe(true)
    // ...while tool execution stays strictly user-scoped, never app-action.
    const executions = roomCalls.filter(({ body }) => body.tool === 'records.query')
    expect(executions).toHaveLength(1)
    expect(
      executions.every(
        ({ request }) =>
          request.headers.get('X-App-Action') === null &&
          request.headers.get('X-User-Id') === 'member-user',
      ),
    ).toBe(true)

    const ownerRequests: Request[] = []
    const ownerRooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          ownerRequests.push(request)
          return Response.json({ success: false, error: 'owner should not need membership lookup' })
        },
      }),
    } as unknown as DurableObjectNamespace
    const ownerToken = await signAgentJwt('https://app.test', 'owner-user')
    const owner = await app.request(
      'https://app.test/_deepspace/agent/tools',
      { headers: { Authorization: `Bearer ${ownerToken}` } },
      env({ ...bindings, RECORD_ROOMS: ownerRooms }),
    )
    expect(owner.status).toBe(200)
    expect(ownerRequests).toEqual([])

    const missingMember = new Hono<TestContext>()
    registerAgent(missingMember, { tools: () => ({}) })
    const denied = await missingMember.request(
      'https://app.test/_deepspace/agent/tools',
      {
        headers: {
          Authorization: `Bearer ${await signAgentJwt('https://app.test', 'not-a-member')}`,
        },
      },
      env({
        ...bindings,
        RECORD_ROOMS: {
          idFromName: (name: string) => name,
          get: () => ({
            fetch: () =>
              Promise.resolve(Response.json({ success: false, error: 'User not found' })),
          }),
        } as unknown as DurableObjectNamespace,
      }),
    )
    expect(denied.status).toBe(403)
  })

  it('answers 503, not 403, when the membership read cannot complete', async () => {
    const app = new Hono<TestContext>()
    registerAgent(app, { tools: () => ({}) })
    const bindings = env({
      APP_NAME: 'Test app',
      AUTH_JWT_ISSUER: TEST_JWT_ISSUER,
      AUTH_JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY,
      DEEPSPACE_APP_ID: 'app_test',
      OWNER_USER_ID: 'owner-user',
      RECORD_ROOMS: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: () => Promise.reject(new Error('room unavailable')) }),
      } as unknown as DurableObjectNamespace,
    })

    const agent = await app.request(
      'https://app.test/_deepspace/agent/tools',
      {
        headers: {
          Authorization: `Bearer ${await signAgentJwt('https://app.test', 'member-user')}`,
        },
      },
      bindings,
    )
    expect(agent.status).toBe(503)
    expect(((await agent.json()) as { code: string }).code).toBe('access_check_unavailable')

    const website = await app.request(
      'https://app.test/api/ai/chats',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await signTestJwt('member-user')}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
      bindings,
    )
    expect(website.status).toBe(503)
    expect(((await website.json()) as { error: string }).error).toBe('Temporarily unavailable')
  })

  it('applies custom agent authorization before both assistant surfaces execute', async () => {
    let authorizations = 0
    const app = new Hono<TestContext>()
    registerAgent(app, {
      tools: () => ({}),
      authorize: () => {
        authorizations++
        return false
      },
    })
    const ownerToken = await signTestJwt('owner-user')
    const agentToken = await signAgentJwt('https://app.test', 'owner-user')
    const bindings = env({
      AUTH_JWT_ISSUER: TEST_JWT_ISSUER,
      AUTH_JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY,
      DEEPSPACE_APP_ID: 'app_test',
      OWNER_USER_ID: 'owner-user',
    })
    const websiteHeaders = {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    }
    const agentHeaders = {
      Authorization: `Bearer ${agentToken}`,
      'Content-Type': 'application/json',
    }

    const website = await app.request(
      'https://app.test/api/ai/chat',
      { method: 'POST', headers: websiteHeaders, body: '{}' },
      bindings,
    )
    const agentAtWebsite = await app.request(
      'https://app.test/api/ai/chat',
      { method: 'POST', headers: agentHeaders, body: '{}' },
      bindings,
    )
    const discovery = await app.request(
      'https://app.test/_deepspace/agent/tools',
      { headers: agentHeaders },
      bindings,
    )
    const invoke = await app.request(
      'https://app.test/_deepspace/agent/tools/nope',
      { method: 'POST', headers: agentHeaders, body: JSON.stringify({ input: {} }) },
      bindings,
    )

    expect(website.status).toBe(403)
    expect(agentAtWebsite.status).toBe(401)
    expect(discovery.status).toBe(403)
    expect(invoke.status).toBe(403)
    expect(authorizations).toBe(3)
  })

  it('allows the website and local assistant registrations to be configured independently', async () => {
    const websiteOnly = new Hono<TestContext>()
    registerAgent(websiteOnly, { tools: () => ({}), local: false })
    const localOnly = new Hono<TestContext>()
    registerAgent(localOnly, { tools: () => ({}), inApp: false })

    expect(
      (await websiteOnly.request('https://app.test/api/ai/chats', { method: 'POST' }, env()))
        .status,
    ).toBe(401)
    expect(
      (await websiteOnly.request('https://app.test/_deepspace/agent/tools', undefined, env()))
        .status,
    ).toBe(404)
    expect(
      (await localOnly.request('https://app.test/api/ai/chats', undefined, env())).status,
    ).toBe(404)
    expect(
      (await localOnly.request('https://app.test/_deepspace/agent/tools', undefined, env())).status,
    ).toBe(401)
  })

  it('keeps auth special cases ahead of the wildcard proxy', async () => {
    const app = new Hono<TestContext>()
    registerAuthAndIntegrationRoutes(app)

    const missingProvider = await app.request(
      'https://example.app.space/api/auth/social-redirect',
      undefined,
      env({ AUTH_WORKER_URL: 'https://auth.example.test' }),
    )
    expect(missingProvider.status).toBe(400)

    const redirect = await app.request(
      'https://example.app.space/api/auth/social-redirect?provider=google',
      undefined,
      env({ AUTH_WORKER_URL: 'https://auth.example.test' }),
    )
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe(
      'https://auth.example.test/login/social?provider=google&returnTo=https%3A%2F%2Fexample.app.space',
    )
  })

  it('keeps debug and user-billed integration routes closed by default', async () => {
    const app = new Hono<TestContext>()
    registerAuthAndIntegrationRoutes(app)

    const debug = await app.request('https://app.test/api/debug/status', undefined, env())
    expect(debug.status).toBe(404)

    const integration = await app.request(
      'https://app.test/api/integrations/google/search',
      undefined,
      env(),
    )
    expect(integration.status).toBe(401)
  })

  it('requires owner/admin auth after production debug routes are enabled', async () => {
    const app = new Hono<TestContext>()
    registerAuthAndIntegrationRoutes(app)
    const baseEnv = {
      ALLOW_DEBUG_ROUTES: 'true',
      AUTH_JWT_ISSUER: TEST_JWT_ISSUER,
      AUTH_JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY,
      DEEPSPACE_APP_ID: 'app_test',
      OWNER_USER_ID: 'owner-user',
    }

    const signedOut = await app.request(
      'https://app.test/api/debug/status',
      undefined,
      env(baseEnv),
    )
    expect(signedOut.status).toBe(401)

    const viewerToken = await signTestJwt('viewer-user')
    const viewerRooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () =>
          Promise.resolve(
            Response.json({
              success: true,
              data: { record: { data: { role: 'viewer' } } },
            }),
          ),
      }),
    } as unknown as DurableObjectNamespace
    const viewer = await app.request(
      'https://app.test/api/debug/status',
      { headers: { Authorization: `Bearer ${viewerToken}` } },
      env({ ...baseEnv, RECORD_ROOMS: viewerRooms }),
    )
    expect(viewer.status).toBe(403)

    const ownerToken = await signTestJwt('owner-user')
    const ownerRooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
      }),
    } as unknown as DurableObjectNamespace
    const owner = await app.request(
      'https://app.test/api/debug/status',
      { headers: { Authorization: `Bearer ${ownerToken}` } },
      env({ ...baseEnv, RECORD_ROOMS: ownerRooms }),
    )
    expect(owner.status).toBe(204)
  })

  it('strips caller identity before a generic WebSocket reaches its room', async () => {
    let forwardedUrl = ''
    let forwardedHeaders = new Headers()
    const stub = {
      fetch(request: Request) {
        forwardedUrl = request.url
        forwardedHeaders = new Headers(request.headers)
        return Promise.resolve(new Response(null, { status: 204 }))
      },
    }
    const namespace = {
      idFromName: (name: string) => name,
      get: () => stub,
    } as unknown as DurableObjectNamespace
    const app = new Hono<TestContext>()
    registerRealtimeRoutes(app)

    const response = await app.request(
      'https://app.test/ws/room-1?userId=spoofed&userName=attacker&role=admin',
      {
        headers: {
          'x-user-id': 'spoofed',
          'x-user-name': 'attacker',
          'x-user-role': 'admin',
        },
      },
      env({ RECORD_ROOMS: namespace }),
    )

    expect(response.status).toBe(204)
    const forwarded = new URL(forwardedUrl)
    expect(forwarded.searchParams.has('userId')).toBe(false)
    expect(forwarded.searchParams.has('userName')).toBe(false)
    expect(forwarded.searchParams.has('role')).toBe(false)
    expect(forwardedHeaders.has('x-user-id')).toBe(false)
    expect(forwardedHeaders.has('x-user-name')).toBe(false)
    expect(forwardedHeaders.has('x-user-role')).toBe(false)
  })

  it('replaces spoofed Yjs identity with verified JWT claims and the document role', async () => {
    const token = await signTestJwt()
    let forwardedUrl = ''
    let forwardedHeaders = new Headers()
    const recordRooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () =>
          Promise.resolve(
            Response.json({
              success: false,
              error: 'Schema not registered for collection: documents',
            }),
          ),
      }),
    } as unknown as DurableObjectNamespace
    const yjsRooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch(request: Request) {
          forwardedUrl = request.url
          forwardedHeaders = new Headers(request.headers)
          return Promise.resolve(new Response(null, { status: 204 }))
        },
      }),
    } as unknown as DurableObjectNamespace
    const app = new Hono<TestContext>()
    registerRealtimeRoutes(app)

    const response = await app.request(
      `https://app.test/ws/yjs/doc-1?token=${encodeURIComponent(token)}` +
        '&userId=spoofed&userName=Attacker&userEmail=attacker%40example.test' +
        '&userImageUrl=https%3A%2F%2Fimages.example.test%2Fattacker.png&role=admin',
      undefined,
      env({
        AUTH_JWT_ISSUER: TEST_JWT_ISSUER,
        AUTH_JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY,
        DEEPSPACE_APP_ID: 'app_test',
        OWNER_USER_ID: 'owner-user',
        RECORD_ROOMS: recordRooms,
        YJS_ROOMS: yjsRooms,
      }),
    )

    expect(response.status).toBe(204)
    const forwarded = new URL(forwardedUrl)
    expect(forwarded.searchParams.has('token')).toBe(false)
    expect(forwarded.searchParams.has('userId')).toBe(false)
    expect(forwarded.searchParams.has('userName')).toBe(false)
    expect(forwarded.searchParams.has('userEmail')).toBe(false)
    expect(forwarded.searchParams.has('userImageUrl')).toBe(false)
    expect(forwarded.searchParams.has('role')).toBe(false)
    expect(decodeRoomIdentityHeader(forwardedHeaders.get('x-user-id'))).toBe('verified-user')
    expect(decodeRoomIdentityHeader(forwardedHeaders.get('x-user-name'))).toBe(
      '你好 👋\nSecond line',
    )
    expect(decodeRoomIdentityHeader(forwardedHeaders.get('x-user-email'))).toBe(
      'verified@example.test',
    )
    expect(decodeRoomIdentityHeader(forwardedHeaders.get('x-user-image-url'))).toBe(
      'https://images.example.test/verified.png',
    )
    expect(decodeRoomIdentityHeader(forwardedHeaders.get('x-user-role'))).toBe('member')
  })

  it('forwards the current app role instead of promoting canvas users', async () => {
    const token = await signTestJwt('viewer-user')
    let forwardedHeaders = new Headers()
    const recordRooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () =>
          Promise.resolve(
            Response.json({
              success: true,
              data: { record: { data: { role: 'viewer' } } },
            }),
          ),
      }),
    } as unknown as DurableObjectNamespace
    const canvasRooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch(request: Request) {
          forwardedHeaders = new Headers(request.headers)
          return Promise.resolve(new Response(null, { status: 204 }))
        },
      }),
    } as unknown as DurableObjectNamespace
    const app = new Hono<TestContext>()
    registerRealtimeRoutes(app)

    const response = await app.request(
      `https://app.test/ws/canvas/canvas-1?token=${encodeURIComponent(token)}`,
      undefined,
      env({
        AUTH_JWT_ISSUER: TEST_JWT_ISSUER,
        AUTH_JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY,
        DEEPSPACE_APP_ID: 'app_test',
        OWNER_USER_ID: 'owner-user',
        RECORD_ROOMS: recordRooms,
        CANVAS_ROOMS: canvasRooms,
      }),
    )

    expect(response.status).toBe(204)
    expect(decodeRoomIdentityHeader(forwardedHeaders.get('x-user-id'))).toBe('viewer-user')
    expect(decodeRoomIdentityHeader(forwardedHeaders.get('x-user-role'))).toBe('viewer')
  })

  it('fails closed when a Yjs document has no authorization record', async () => {
    const token = await signTestJwt()
    let yjsRequests = 0
    const recordRooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () =>
          Promise.resolve(
            Response.json({
              success: false,
              error: 'Record not found',
            }),
          ),
      }),
    } as unknown as DurableObjectNamespace
    const yjsRooms = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: () => {
          yjsRequests++
          return Promise.resolve(new Response(null, { status: 204 }))
        },
      }),
    } as unknown as DurableObjectNamespace
    const app = new Hono<TestContext>()
    registerRealtimeRoutes(app)

    const response = await app.request(
      `https://app.test/ws/yjs/doc-1?token=${encodeURIComponent(token)}`,
      undefined,
      env({
        AUTH_JWT_ISSUER: TEST_JWT_ISSUER,
        AUTH_JWT_PUBLIC_KEY: TEST_JWT_PUBLIC_KEY,
        DEEPSPACE_APP_ID: 'app_test',
        OWNER_USER_ID: 'owner-user',
        RECORD_ROOMS: recordRooms,
        YJS_ROOMS: yjsRooms,
      }),
    )

    expect(response.status).toBe(403)
    expect(yjsRequests).toBe(0)
  })

  it('requires authentication before documents and server actions touch state', async () => {
    const realtime = new Hono<TestContext>()
    registerRealtimeRoutes(realtime)
    const yjs = await realtime.request('https://app.test/ws/yjs/doc-1', undefined, env())
    expect(yjs.status).toBe(401)

    const actions = new Hono<TestContext>()
    registerActionRoutes(actions, async () => null)
    const action = await actions.request(
      'https://app.test/api/actions/example',
      { method: 'POST', body: '{}' },
      env(),
    )
    expect(action.status).toBe(401)
  })

  it('refuses a cookie-authenticated action call instead of crashing on the missing bearer token', async () => {
    // `resolveAuth` is pluggable and may accept a cookie session — the caller
    // is then authenticated with no Authorization header at all. Actions need
    // the raw JWT (user-billed integrations forward it), and reading it
    // unguarded used to throw a TypeError and answer 500.
    const actions = new Hono<TestContext>()
    const cookieSession = (async () => ({
      userId: 'cookie-user',
      claims: { sub: 'cookie-user' },
    })) as unknown as () => Promise<null>
    registerActionRoutes(actions, cookieSession)

    const action = await actions.request(
      'https://app.test/api/actions/example',
      { method: 'POST', body: '{}', headers: { cookie: 'session=abc' } },
      env(),
    )

    expect(action.status).toBe(401)
    expect(await action.json()).toEqual({ error: 'Unauthorized' })
  })

  it('rejects unlisted browser proxies and registers the SPA fallback last', async () => {
    const platform = new Hono<TestContext>()
    registerPlatformProxyRoutes(platform)
    const unlisted = await platform.request(
      'https://app.test/_deepspace/subscriptions/sync',
      { method: 'POST' },
      env(),
    )
    expect(unlisted.status).toBe(404)

    const { assets, assetRequests } = spaAssetLayer()
    const staticApp = new Hono<TestContext>()
    registerStaticRoutes(staticApp)
    const missingApi = await staticApp.request(
      'https://app.test/api/definitely-not-a-real-route',
      undefined,
      env({ ASSETS: assets }),
    )
    expect(missingApi.status).toBe(404)
    expect(await missingApi.json()).toEqual({ error: 'not_found' })
    expect(assetRequests).toEqual([])

    const fallback = await staticApp.request(
      'https://app.test/client/route',
      undefined,
      env({ ASSETS: assets }),
    )
    expect(fallback.status).toBe(200)
    expect(await fallback.text()).toBe(APP_SHELL)
    // The binding reported a real miss; the WORKER chose the shell for it —
    // asking for `/`, because `/index.html` would come back as a redirect.
    expect(assetRequests).toEqual(['/client/route', '/'])
    expect(fallback.status).not.toBe(307)
  })

  /**
   * The failure this suite previously certified as passing. A client holding a
   * stale index.html asks for a hashed chunk the new release deleted; the
   * asset layer answers with the shell at 200 text/html, and the browser
   * parses HTML as JavaScript — a white screen with nothing to retry on.
   */
  it('404s a missing build asset instead of serving HTML a script tag would parse', async () => {
    const { assets } = spaAssetLayer({ '/assets/index-NEW.js': ['export {}', 'text/javascript'] })
    const staticApp = new Hono<TestContext>()
    registerStaticRoutes(staticApp)

    const gone = await staticApp.request(
      'https://app.test/assets/index-OLD.js',
      undefined,
      env({ ASSETS: assets }),
    )
    expect(gone.status).toBe(404)
    expect(gone.headers.get('content-type')).not.toContain('text/html')

    // The asset that does exist is still served untouched.
    const live = await staticApp.request(
      'https://app.test/assets/index-NEW.js',
      undefined,
      env({ ASSETS: assets }),
    )
    expect(live.status).toBe(200)
    expect(await live.text()).toBe('export {}')

    // A real .html asset is a match, not the fallback — it must pass through.
    const { assets: withPage } = spaAssetLayer({
      '/about.html': ['<h1>About</h1>', 'text/html'],
    })
    const page = await staticApp.request(
      'https://app.test/about.html',
      undefined,
      env({ ASSETS: withPage }),
    )
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<h1>About</h1>')
  })

  /**
   * The reserved list is a DENY-list — the CLI strips these from the app's own
   * array, and the deploy worker re-adds them from its own baseline. So the
   * CLI sending nothing is CORRECT, and the only thing that proves the paths
   * reach Cloudflare is the worker's side (cloudflare-deploy.test.ts). This
   * pins the CLI half of that contract so the two cannot silently disagree.
   */
  it('strips the agent paths from the app config, leaving the worker baseline to send them', () => {
    const routes = resolveDeployRunWorkerFirst({
      assets: {
        run_worker_first: [
          '/api/*',
          '/llms.txt',
          '/.well-known/mcp',
          '/.well-known/mcp.json',
          '/.well-known/mcp/*',
          '/custom/*',
        ],
      },
    })
    // Only the app's OWN addition survives; everything reserved is the
    // platform's to send.
    expect(routes).toEqual(['/custom/*'])
  })

  /**
   * These paths are how an agent asks an origin to describe itself. Answering
   * the SPA shell with 200 text/html tells it the app publishes a manifest,
   * and it then reads the homepage as one — so the SPA fallback is withheld
   * and they 404 when the app publishes nothing there.
   */
  it('never answers agent-protocol paths with the SPA shell', async () => {
    const { assets, assetRequests } = spaAssetLayer()
    const staticApp = new Hono<TestContext>()
    registerStaticRoutes(staticApp)

    for (const path of [
      '/llms.txt',
      '/llms-full.txt',
      '/.well-known/mcp',
      '/.well-known/mcp.json',
      '/.well-known/mcp/server-card.json',
    ]) {
      const response = await staticApp.request(
        `https://app.test${path}`,
        undefined,
        env({ ASSETS: assets }),
      )
      expect(response.status, path).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    }
    // The asset layer WAS consulted for each; the shell it returned is what
    // gets withheld. Nothing asks a second time for /index.html.
    expect(assetRequests).not.toContain('/index.html')

    // Unrelated well-known paths keep their normal SPA behavior — the
    // reservation is the named agent surface, not all of /.well-known.
    const other = await staticApp.request(
      'https://app.test/.well-known/apple-app-site-association',
      undefined,
      env({ ASSETS: assets }),
    )
    expect(other.status).toBe(200)
  })

  /** A hand-authored public/llms.txt is a real answer; reserving the path must
   *  not take it away, only the SPA shell standing in for it. */
  it('serves a real asset at an agent path when the app ships one', async () => {
    const { assets } = spaAssetLayer({ '/llms.txt': ['# My App\n', 'text/plain'] })
    const staticApp = new Hono<TestContext>()
    registerStaticRoutes(staticApp)

    const response = await staticApp.request(
      'https://app.test/llms.txt',
      undefined,
      env({ ASSETS: assets }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('# My App\n')
  })
})

/**
 * The seam this whole file exists to guard.
 *
 * The scaffold's wrangler.toml, the deploy worker's upload metadata, and the
 * app's own route handler all depend on the SAME routing decisions — across
 * three packages, in three formats, one of them TOML that cannot import
 * anything. When they disagreed the result was not a build error but months of
 * unreachable code and an app shell served in place of deleted build chunks.
 *
 * TOML can't import the constants, so it gets pinned to them here instead.
 */
describe('the app/platform routing contract', () => {
  it('pins the scaffold wrangler.toml to the shared contract', async () => {
    const { readFileSync } = await import('node:fs')
    const toml = readFileSync(join(TEMPLATES_DIR, 'base', 'wrangler.toml'), 'utf8')

    // Both `wrangler dev` and the deploy read this line — the platform honors
    // what the app declares. It has to be "none" specifically, because this
    // template's worker owns the fallback: under any other setting the asset
    // layer answers misses itself and registerStaticRoutes never runs.
    expect(toml).toContain(`not_found_handling = "none"`)
    expect(isAssetNotFoundHandling('none')).toBe(true)
    for (const flag of REQUIRED_COMPATIBILITY_FLAGS) {
      expect(toml, `wrangler.toml must declare ${flag}`).toContain(flag)
    }
    // The deploy re-adds these from the platform's own list, so production is
    // right either way — but `deepspace dev` reads THIS file, and a missing
    // entry means a path the worker sees locally and not in production.
    for (const route of SDK_RUN_WORKER_FIRST) {
      expect(toml, `wrangler.toml must list ${route} in run_worker_first`).toContain(`"${route}"`)
    }
  })

  it('answers reserved platform paths from one predicate, not a per-app copy', () => {
    // The template used to keep its own list of the extensionless agent paths;
    // this is the same knowledge, imported.
    expect(isPlatformReservedPath('/.well-known/mcp')).toBe(true)
    expect(isPlatformReservedPath('/.well-known/mcp/server-card.json')).toBe(true)
    expect(isPlatformReservedPath('/llms.txt')).toBe(true)
    expect(isPlatformReservedPath('/_documentation/anything')).toBe(true)
    expect(isPlatformReservedPath('/settings')).toBe(false)
    expect(isPlatformReservedPath('/.well-known/apple-app-site-association')).toBe(false)
  })

  it('merges an app’s own flags over the required set without letting it undo them', () => {
    expect(resolveCompatibilityFlags(['nodejs_als'])).toEqual(
      expect.arrayContaining([...REQUIRED_COMPATIBILITY_FLAGS, 'nodejs_als']),
    )
    // A flag that reverses the platform's routing contract is dropped, not honored.
    const reversed = resolveCompatibilityFlags(['assets_navigation_prefers_asset_serving'])
    expect(reversed).not.toContain('assets_navigation_prefers_asset_serving')
    expect(reversed).toContain('assets_navigation_has_no_effect')
    // Declaring nothing still yields the platform's required set.
    expect(resolveCompatibilityFlags(undefined)).toEqual([...REQUIRED_COMPATIBILITY_FLAGS])
  })
})

/**
 * The client half and the server half of one contract.
 *
 * The SDK's hooks call platform endpoints through the app's proxy, and that
 * proxy is an ALLOW-LIST — so a call the list does not name is refused by the
 * app's own worker. Only this package knows which endpoints its hooks call, so
 * shipping a hook without its route would 404 in a customer's browser, and
 * only in apps scaffolded before the change. Fresh scaffolds would pass every
 * test we run.
 */
describe('client hooks and the app proxy allow-list', () => {
  it('proxies every platform endpoint the client hooks actually call', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const clientDir = fileURLToPath(new URL('../../../client', import.meta.url))

    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__') walk(full)
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          files.push(full)
        }
      }
    }
    walk(clientDir)

    const called = new Set<string>()
    for (const file of files) {
      // Comments mention paths they do not call — strip them before scanning.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      for (const match of source.matchAll(/['"`](\/_deepspace\/[A-Za-z0-9/_-]+)/g)) {
        called.add(match[1])
      }
    }

    // A scan that finds nothing would pass this test vacuously.
    expect(called.size).toBeGreaterThan(0)
    const proxied = new Set(BROWSER_PROXY_ROUTES.map((route) => route.path))
    for (const path of called) {
      expect(
        [...proxied],
        `${path} is called by a client hook but missing from BROWSER_PROXY_ROUTES — ` +
          `apps would refuse it at their own proxy`,
      ).toContain(path)
    }
  })
})
