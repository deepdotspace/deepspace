import { beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import { importPKCS8, SignJWT } from 'jose'
import { TEMPLATES_DIR } from './template-assembly'
import { resolveDeployRunWorkerFirst } from '../deploy/build'

interface TestEnv {
  ASSETS?: Fetcher
  AUTH_JWT_ISSUER?: string
  AUTH_JWT_PUBLIC_KEY?: string
  AUTH_WORKER_URL?: string
  DEEPSPACE_APP_ID?: string
  OWNER_USER_ID?: string
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
    expect(await fallback.text()).toBe('app shell')
    expect(assetRequests).toEqual(['/client/route', '/index.html'])
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
    // The asset layer WAS consulted for each — only the SPA retry is withheld,
    // so nothing asked for /index.html.
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
    const assets = {
      async fetch(request: Request) {
        return new URL(request.url).pathname === '/llms.txt'
          ? new Response('# My App\n', { status: 200, headers: { 'content-type': 'text/plain' } })
          : new Response(null, { status: 404 })
      },
    } as Fetcher
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
