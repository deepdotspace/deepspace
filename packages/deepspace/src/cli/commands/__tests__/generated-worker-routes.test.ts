import { beforeAll, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import { importPKCS8, SignJWT } from 'jose'
import { TEMPLATES_DIR } from './template-assembly'
import {
  registerDocsAssistantRoutes as registerSdkDocsAssistantRoutes,
  registerDocsStaticRoutes as registerSdkDocsStaticRoutes,
} from '../../../server/utils/docs-assistant-routes'
import { registerDocsMcpRoutes as registerSdkDocsMcpRoutes } from '../../../server/utils/docs-mcp-routes'

interface TestEnv {
  ASSETS?: Fetcher
  AUTH_JWT_ISSUER?: string
  AUTH_JWT_PUBLIC_KEY?: string
  AUTH_WORKER_URL?: string
  DEEPSPACE_APP_ID?: string
  OWNER_USER_ID?: string
  APP_NAME?: string
  APP_OWNER_JWT?: string
  API_WORKER?: Fetcher
  API_WORKER_URL?: string
  DOCS_ASSISTANT_LIMITER?: DurableObjectNamespace
  RECORD_ROOMS?: DurableObjectNamespace
  YJS_ROOMS?: DurableObjectNamespace
}

type TestContext = { Bindings: TestEnv }
type RegisterRoutes = (app: Hono<TestContext>) => void
type RegisterAuthenticatedRoutes = (
  app: Hono<TestContext>,
  resolveAuth: () => Promise<null>,
) => void

let registerActionRoutes: RegisterAuthenticatedRoutes
let registerAuthAndIntegrationRoutes: RegisterRoutes
let registerPlatformProxyRoutes: RegisterRoutes
let registerRealtimeRoutes: RegisterRoutes
let registerStaticRoutes: RegisterRoutes
let registerDocsAssistantRoutes: RegisterAuthenticatedRoutes
let registerDocsMcpRoutes: RegisterRoutes
let registerDocsStaticRoutes: RegisterRoutes

beforeAll(async () => {
  // A computed file URL keeps generated-app sources outside this package's
  // TypeScript rootDir while Vitest still executes the real modules.
  const serverDirectory = join(TEMPLATES_DIR, 'base', 'src', 'server')
  const actionRoutes = await import(pathToFileURL(join(serverDirectory, 'action-routes.ts')).href)
  const httpRoutes = await import(pathToFileURL(join(serverDirectory, 'http-routes.ts')).href)
  const realtimeRoutes = await import(
    pathToFileURL(join(serverDirectory, 'realtime-routes.ts')).href
  )

  registerActionRoutes = actionRoutes.registerActionRoutes as RegisterAuthenticatedRoutes
  registerAuthAndIntegrationRoutes = httpRoutes.registerAuthAndIntegrationRoutes as RegisterRoutes
  registerPlatformProxyRoutes = httpRoutes.registerPlatformProxyRoutes as RegisterRoutes
  registerStaticRoutes = httpRoutes.registerStaticRoutes as RegisterRoutes
  registerRealtimeRoutes = realtimeRoutes.registerRealtimeRoutes as RegisterRoutes
  registerDocsAssistantRoutes = registerSdkDocsAssistantRoutes as RegisterAuthenticatedRoutes
  registerDocsMcpRoutes = registerSdkDocsMcpRoutes as RegisterRoutes
  registerDocsStaticRoutes = registerSdkDocsStaticRoutes as RegisterRoutes
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

async function signTestJwt(): Promise<string> {
  const privateKey = await importPKCS8(TEST_JWT_PRIVATE_KEY, 'ES256')
  return new SignJWT({
    name: 'Verified Name',
    email: 'verified@example.test',
    image: 'https://images.example.test/verified.png',
  })
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject('verified-user')
    .setIssuer(TEST_JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

describe('generated worker route owners', () => {
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

  it('strips caller identity before a generic WebSocket reaches its room', async () => {
    let forwardedUrl = ''
    const stub = {
      fetch(request: Request) {
        forwardedUrl = request.url
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
      undefined,
      env({ RECORD_ROOMS: namespace }),
    )

    expect(response.status).toBe(204)
    const forwarded = new URL(forwardedUrl)
    expect(forwarded.searchParams.has('userId')).toBe(false)
    expect(forwarded.searchParams.has('userName')).toBe(false)
    expect(forwarded.searchParams.has('role')).toBe(false)
  })

  it('replaces spoofed Yjs identity with verified JWT claims and the document role', async () => {
    const token = await signTestJwt()
    let forwardedUrl = ''
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
    expect(forwarded.searchParams.get('userId')).toBe('verified-user')
    expect(forwarded.searchParams.get('userName')).toBe('Verified Name')
    expect(forwarded.searchParams.get('userEmail')).toBe('verified@example.test')
    expect(forwarded.searchParams.get('userImageUrl')).toBe(
      'https://images.example.test/verified.png',
    )
    expect(forwarded.searchParams.get('role')).toBe('member')
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

  it('rejects unlisted browser proxies and registers the SPA fallback last', async () => {
    const platform = new Hono<TestContext>()
    registerPlatformProxyRoutes(platform)
    const unlisted = await platform.request(
      'https://app.test/_deepspace/subscriptions/sync',
      { method: 'POST' },
      env(),
    )
    expect(unlisted.status).toBe(404)

    const assetRequests: string[] = []
    const assets = {
      async fetch(request: Request) {
        assetRequests.push(new URL(request.url).pathname)
        return request.url.endsWith('/index.html')
          ? new Response('app shell', { status: 200 })
          : new Response(null, { status: 404 })
      },
    } as Fetcher
    const staticApp = new Hono<TestContext>()
    registerStaticRoutes(staticApp)
    const fallback = await staticApp.request(
      'https://app.test/client/route',
      undefined,
      env({ ASSETS: assets }),
    )
    expect(fallback.status).toBe(200)
    expect(await fallback.text()).toBe('app shell')
    expect(assetRequests).toEqual(['/client/route', '/index.html'])

    const docsAssets = {
      async fetch(request: Request) {
        assetRequests.push(new URL(request.url).pathname)
        if (request.url.endsWith('/_docs/get-started/introduction.md')) {
          return new Response('# Introduction', {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          })
        }
        return request.url.endsWith('/_docs/404.html')
          ? new Response('docs not found', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            })
          : new Response(null, { status: 404 })
      },
    } as Fetcher
    const docsApp = new Hono<TestContext>()
    registerStaticRoutes(docsApp)
    const docsFallback = await docsApp.request(
      'https://docs.app.test/_docs/missing/index.html',
      undefined,
      env({ ASSETS: docsAssets }),
    )
    expect(docsFallback.status).toBe(404)
    expect(await docsFallback.text()).toBe('docs not found')
    expect(docsFallback.headers.get('Content-Type')).toContain('text/html')
    expect(assetRequests.slice(-2)).toEqual(['/_docs/missing/index.html', '/_docs/404.html'])

    const nativeDocsApp = new Hono<TestContext>()
    registerDocsStaticRoutes(nativeDocsApp)
    const nativeDocs = await nativeDocsApp.request(
      'https://docs.app.test/_docs/missing/index.html',
      undefined,
      env({ ASSETS: docsAssets }),
    )
    expect(nativeDocs.status).toBe(404)
    expect(nativeDocs.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(nativeDocs.headers.get('Content-Security-Policy')).toContain("script-src 'self'")
    expect(nativeDocs.headers.get('Cache-Control')).toContain('no-transform')

    const nativeMarkdown = await nativeDocsApp.request(
      'https://docs.app.test/_docs/get-started/introduction.md',
      undefined,
      env({ ASSETS: docsAssets }),
    )
    expect(nativeMarkdown.status).toBe(200)
    expect(nativeMarkdown.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
    expect(await nativeMarkdown.text()).toBe('# Introduction')
  })

  it('fails the docs assistant closed when no compiled docs manifest exists', async () => {
    const app = new Hono<TestContext>()
    registerDocsAssistantRoutes(app, async () => null)
    const assets = {
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
    } as unknown as Fetcher

    const response = await app.request(
      'https://docs.app.test/api/ai/docs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'How do I start?' }),
      },
      env({ ASSETS: assets }),
    )

    expect(response.status).toBe(404)
  })

  it('fails public owner-paid docs AI closed without the durable limiter binding', async () => {
    const app = new Hono<TestContext>()
    registerDocsAssistantRoutes(app, async () => null)
    const assets = {
      async fetch(request: Request | string) {
        const path = new URL(typeof request === 'string' ? request : request.url).pathname
        if (path.endsWith('/manifest.json')) {
          return Response.json({
            sourceHash: 'a'.repeat(64),
            name: 'Test docs',
            assistant: { access: 'public' },
          })
        }
        if (path.endsWith('/assistant-index.json')) {
          return Response.json([{ id: 'home:0', route: '/', title: 'Home', text: 'Start here.' }])
        }
        return new Response(null, { status: 404 })
      },
    } as unknown as Fetcher
    const api = {
      fetch: () => Promise.resolve(new Response(null, { status: 500 })),
    } as unknown as Fetcher

    const response = await app.request(
      'https://docs.app.test/api/ai/docs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '192.0.2.10',
          'x-deepspace-surface': 'docs',
        },
        body: JSON.stringify({ question: 'How do I start?' }),
      },
      env({
        ASSETS: assets,
        API_WORKER: api,
        APP_NAME: 'Test docs',
        APP_OWNER_JWT: 'owner-token',
        DEEPSPACE_APP_ID: 'app_test',
      }),
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'Documentation assistant rate limiting is not configured',
    })

    const oversized = await app.request(
      'https://docs.app.test/api/ai/docs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(128 * 1024 + 1),
          'CF-Connecting-IP': '192.0.2.10',
          'x-deepspace-surface': 'docs',
        },
        body: '{}',
      },
      env({
        ASSETS: assets,
        API_WORKER: api,
        APP_NAME: 'Test docs',
        APP_OWNER_JWT: 'owner-token',
        DEEPSPACE_APP_ID: 'app_test',
      }),
    )
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: `request exceeds ${128 * 1024} bytes` })
  })

  it('serves stateless, read-only MCP tools only on the public docs surface', async () => {
    const app = new Hono<TestContext>()
    registerDocsMcpRoutes(app)
    const limiterFetch = vi.fn(async (request: Request | string) => {
      const path = new URL(typeof request === 'string' ? request : request.url).pathname
      return path === '/acquire'
        ? Response.json({ ok: true, leaseId: 'lease-1' })
        : Response.json({ ok: true })
    })
    const limiter = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: limiterFetch }),
    } as unknown as DurableObjectNamespace
    const assetUrls: string[] = []
    const assets = {
      async fetch(request: Request | string) {
        const url = typeof request === 'string' ? request : request.url
        assetUrls.push(url)
        const path = new URL(url).pathname
        if (path.endsWith('/manifest.json')) {
          return Response.json({
            sourceHash: 'mcp-source',
            name: 'Test docs',
            assistant: { access: 'disabled' },
            mcp: { access: 'public' },
          })
        }
        if (path.endsWith('/assistant-index.json')) {
          return Response.json([
            { id: 'home:0', route: '/', title: 'Home', text: 'Install with pnpm.' },
            { id: 'guide:0', route: '/guide', title: 'Guide', text: 'Deploy to staging.' },
          ])
        }
        if (path.endsWith('/skill.md')) {
          return new Response('---\nname: test-docs\ndescription: Test docs.\n---\n\n# Test docs\n')
        }
        if (path.endsWith('/guide.md')) return new Response('# Guide\n\nDeploy to staging.')
        return new Response(null, { status: 404 })
      },
    } as unknown as Fetcher
    const bindings = env({
      ASSETS: assets,
      DEEPSPACE_APP_ID: 'app_test',
      DOCS_ASSISTANT_LIMITER: limiter,
    })

    const hiddenOnApp = await app.request('https://app.test/mcp', { method: 'POST' }, bindings)
    expect(hiddenOnApp.status).toBe(404)

    const initialize = await app.request(
      'https://docs.app.test/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-deepspace-surface': 'docs' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '1' } },
        }),
      },
      bindings,
    )
    expect(initialize.status).toBe(200)
    expect(await initialize.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } } },
    })

    const list = await app.request(
      'https://docs.app.test/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-deepspace-surface': 'docs' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      },
      bindings,
    )
    const listed = await list.json<{ result: { tools: Array<{ name: string }> } }>()
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(['docs_search', 'docs_read'])
    expect(limiterFetch).not.toHaveBeenCalled()

    const resources = await app.request(
      'https://docs.app.test/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-deepspace-surface': 'docs' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list' }),
      },
      bindings,
    )
    const resourcesBody = await resources.json<{
      result: { resources: Array<{ uri: string; mimeType: string }> }
    }>()
    expect(resourcesBody.result.resources).toEqual([
      expect.objectContaining({
        uri: 'https://docs.app.test/skill.md',
        mimeType: 'text/markdown',
      }),
    ])

    const resourceRead = await app.request(
      'https://docs.app.test/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-deepspace-surface': 'docs' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'resources/read',
          params: { uri: 'https://docs.app.test/skill.md' },
        }),
      },
      bindings,
    )
    const resourceReadBody = await resourceRead.json<{
      result: { contents: Array<{ text: string }> }
    }>()
    expect(resourceReadBody.result.contents[0]?.text).toContain('name: test-docs')
    expect(limiterFetch).not.toHaveBeenCalled()

    const read = await app.request(
      'https://docs.app.test/mcp',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-deepspace-surface': 'docs',
          'MCP-Protocol-Version': '2025-11-25',
          'CF-Connecting-IP': '192.0.2.55',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'docs_read', arguments: { route: '/guide' } },
        }),
      },
      bindings,
    )
    const readBody = await read.json<{
      result: { structuredContent: { markdown: string; url: string } }
    }>()
    expect(readBody.result.structuredContent.markdown).toContain('Deploy to staging.')
    expect(readBody.result.structuredContent.url).toBe('https://docs.app.test/guide')
    expect(limiterFetch).toHaveBeenCalledTimes(2)

    const badOrigin = await app.request(
      'https://docs.app.test/mcp',
      {
        method: 'POST',
        headers: { Origin: 'https://attacker.example', 'x-deepspace-surface': 'docs' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
      },
      bindings,
    )
    expect(badOrigin.status).toBe(403)

    const oversized = await app.request(
      'https://docs.app.test/mcp',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(64_000 * 4 + 1),
          'x-deepspace-surface': 'docs',
        },
        body: '{}',
      },
      bindings,
    )
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({
      error: { code: -32600, message: `Request exceeds ${64_000 * 4} bytes` },
    })
    expect(assetUrls.every((url) => new URL(url).origin === 'https://docs.app.test')).toBe(true)
  })
})
