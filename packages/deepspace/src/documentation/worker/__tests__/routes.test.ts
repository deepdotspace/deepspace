import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { registerDeepSpaceDocumentation, type DeepSpaceDocumentationRouteEnv } from '../routes'

describe('native documentation route facade', () => {
  it('registers every documentation protocol through one ordered app call', () => {
    const app = new Hono<{ Bindings: DeepSpaceDocumentationRouteEnv }>()
    registerDeepSpaceDocumentation(app, {
      resolveAuth: async () => null,
      config: { name: 'Documentation' },
    })

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'ALL /*',
      'POST /docs/api/ai',
      'GET /docs/mcp',
      'POST /docs/mcp',
      'GET /docs/.well-known/mcp',
      'GET /docs/.well-known/mcp.json',
      'GET /docs/.well-known/mcp/server-card.json',
      'GET /docs/.well-known/mcp/server-cards.json',
      'GET /docs',
      'GET /docs/*',
    ])
  })

  it('keeps generated build namespaces private without touching the asset binding', async () => {
    let assetRequests = 0
    const app = new Hono<{ Bindings: DeepSpaceDocumentationRouteEnv }>()
    registerDeepSpaceDocumentation(app, { resolveAuth: async () => null })
    const env = {
      ASSETS: {
        fetch: async () => {
          assetRequests++
          return new Response('private')
        },
      },
    } as unknown as DeepSpaceDocumentationRouteEnv

    for (const path of [
      '/_documentation/manifest.json',
      '/_documentation-root/assistant-index.json',
      '/%5fdocumentation/manifest.json',
      '/%5Fdocumentation%2Droot/assistant-index.json',
      '//_documentation/manifest.json',
      '/%2F_documentation/manifest.json',
      '/%252F_documentation-root/assistant-index.json',
    ]) {
      expect((await app.request(`https://app.test${path}`, undefined, env)).status).toBe(404)
    }
    expect(assetRequests).toBe(0)
  })

  it('serves every advertised skill URL through the public facade', async () => {
    const requested: string[] = []
    const app = new Hono<{ Bindings: DeepSpaceDocumentationRouteEnv }>()
    registerDeepSpaceDocumentation(app, { resolveAuth: async () => null })
    const resources = [
      '/skill.md',
      '/.well-known/agent-skills/example/skill.md',
      '/.well-known/agent-skills/index.json',
    ]
    const env = {
      ASSETS: {
        fetch: async (request: Request | string) => {
          const pathname = new URL(typeof request === 'string' ? request : request.url).pathname
          requested.push(pathname)
          if (pathname === '/_documentation/manifest.json') {
            return Response.json({
              version: 2,
              sourceHash: 'source',
              name: 'Example',
              routes: ['/'],
              resources,
              assistant: { access: 'disabled' },
              mcp: { access: 'public' },
            })
          }
          if (pathname.endsWith('.json')) return Response.json({ skills: [] })
          return new Response('# Example skill', {
            headers: { 'Content-Type': 'text/markdown' },
          })
        },
      },
    } as unknown as DeepSpaceDocumentationRouteEnv

    for (const resource of resources) {
      const response = await app.request(`https://app.test/docs${resource}`, undefined, env)
      expect(response.status, resource).toBe(200)
    }
    expect(requested).toContain('/_documentation/skill.md')
    expect(requested).toContain('/_documentation/.well-known/agent-skills/example/skill.md')
  })

  it('maps public documentation routes into the private artifact namespace', async () => {
    const requested: string[] = []
    const app = new Hono<{ Bindings: DeepSpaceDocumentationRouteEnv }>()
    registerDeepSpaceDocumentation(app, { resolveAuth: async () => null })
    const env = {
      ASSETS: {
        fetch: async (request: Request | string) => {
          const pathname = new URL(typeof request === 'string' ? request : request.url).pathname
          requested.push(pathname)
          if (pathname.endsWith('/manifest.json')) {
            return Response.json({
              version: 2,
              sourceHash: 'source',
              name: 'Example',
              routes: ['/', '/guides/start', '/guides/v1.0', '/old-guide'],
              resources: ['/guides/start.md', '/assets/documentation.css'],
              assistant: { access: 'disabled' },
              mcp: { access: 'disabled' },
            })
          }
          if (pathname.endsWith('/index.html')) {
            return new Response(null, {
              status: 307,
              headers: { Location: pathname.slice(0, -'index.html'.length) },
            })
          }
          return new Response('<main>Documentation</main>', {
            headers: { 'Content-Type': 'text/html' },
          })
        },
      },
    } as unknown as DeepSpaceDocumentationRouteEnv

    expect((await app.request('https://app.test/docs', undefined, env)).status).toBe(200)
    expect((await app.request('https://app.test/docs/guides/start', undefined, env)).status).toBe(
      200,
    )
    expect((await app.request('https://app.test/docs/guides/v1.0', undefined, env)).status).toBe(
      200,
    )
    expect(
      (await app.request('https://app.test/docs/guides/start.md', undefined, env)).status,
    ).toBe(200)
    expect(
      (await app.request('https://app.test/docs/assets/documentation.css', undefined, env)).status,
    ).toBe(200)
    expect((await app.request('https://app.test/docs/old-guide', undefined, env)).status).toBe(200)
    expect((await app.request('https://app.test/docs/guides/missing', undefined, env)).status).toBe(
      404,
    )
    const markdownMiss = await app.request(
      'https://app.test/docs/guides/missing.md',
      undefined,
      env,
    )
    expect(markdownMiss.status).toBe(404)
    expect(markdownMiss.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
    expect(await markdownMiss.text()).toBe(
      'No documentation page at /docs/guides/missing.md. See /docs/llms.txt for every published page.\n',
    )
    expect(
      (await app.request('https://app.test/docs/guides/missing.json', undefined, env)).status,
    ).toBe(404)
    expect(requested).toEqual([
      '/_documentation/manifest.json',
      '/_documentation/index.html',
      '/_documentation/',
      '/_documentation/manifest.json',
      '/_documentation/guides/start/index.html',
      '/_documentation/guides/start/',
      '/_documentation/manifest.json',
      '/_documentation/guides/v1.0/index.html',
      '/_documentation/guides/v1.0/',
      '/_documentation/manifest.json',
      '/_documentation/guides/start.md',
      '/_documentation/manifest.json',
      '/_documentation/assets/documentation.css',
      '/_documentation/manifest.json',
      '/_documentation/old-guide/index.html',
      '/_documentation/old-guide/',
      '/_documentation/manifest.json',
      '/_documentation/404.html',
      // The Markdown miss answers in plain text without touching 404.html.
      '/_documentation/manifest.json',
      '/_documentation/manifest.json',
      '/_documentation/404.html',
    ])
  })

  it('matches encoded page and media paths canonically without decoding path separators', async () => {
    const requested: string[] = []
    const app = new Hono<{ Bindings: DeepSpaceDocumentationRouteEnv }>()
    registerDeepSpaceDocumentation(app, { resolveAuth: async () => null })
    const env = {
      ASSETS: {
        fetch: async (request: Request | string) => {
          const pathname = new URL(typeof request === 'string' ? request : request.url).pathname
          requested.push(pathname)
          if (pathname.endsWith('/manifest.json')) {
            return Response.json({
              version: 2,
              sourceHash: 'source',
              name: 'Example',
              routes: ['/', '/caf%C3%A9%20guide'],
              resources: ['/media/caf%C3%A9%20logo.png'],
              assistant: { access: 'disabled' },
              mcp: { access: 'disabled' },
            })
          }
          return new Response('documentation')
        },
      },
    } as unknown as DeepSpaceDocumentationRouteEnv

    expect(
      (await app.request('https://app.test/docs/caf%c3%a9%20guide', undefined, env)).status,
    ).toBe(200)
    expect(
      (await app.request('https://app.test/docs/media/caf%c3%a9%20logo.png', undefined, env))
        .status,
    ).toBe(200)
    expect(
      (await app.request('https://app.test/docs/media/caf%C3%A9%2flogo.png', undefined, env))
        .status,
    ).toBe(404)
    expect((await app.request('https://app.test/docs/media/%ZZ.png', undefined, env)).status).toBe(
      404,
    )
    expect(requested).toContain('/_documentation/caf%C3%A9%20guide/index.html')
    expect(requested).toContain('/_documentation/media/caf%C3%A9%20logo.png')
    expect(requested).not.toContain('/_documentation/media/caf%C3%A9/logo.png')
  })

  it('mounts a separately compiled root variant only on an explicit domain', async () => {
    const requested: string[] = []
    const app = new Hono<{ Bindings: DeepSpaceDocumentationRouteEnv }>()
    registerDeepSpaceDocumentation(app, {
      resolveAuth: async () => null,
      config: { domains: ['docs.example.com'] },
    })
    app.get('/api/auth', (c) => c.json({ route: 'application-auth-root' }))
    app.post('/api/auth/token', (c) => c.json({ token: 'application-auth' }))
    app.get('*', (c) => c.text('application'))
    const env = {
      ASSETS: {
        fetch: async (request: Request | string) => {
          const pathname = new URL(typeof request === 'string' ? request : request.url).pathname
          requested.push(pathname)
          if (pathname.endsWith('/manifest.json')) {
            return Response.json({
              version: 2,
              sourceHash: 'source',
              name: 'Example',
              routes: ['/', '/guide'],
              resources: [],
              assistant: { access: 'disabled' },
              mcp: { access: 'disabled' },
            })
          }
          if (pathname.endsWith('/index.html')) {
            return new Response(null, {
              status: 307,
              headers: { Location: pathname.slice(0, -'index.html'.length) },
            })
          }
          return new Response('documentation', { headers: { 'Content-Type': 'text/html' } })
        },
      },
    } as unknown as DeepSpaceDocumentationRouteEnv

    expect(await (await app.request('https://docs.example.com/', undefined, env)).text()).toBe(
      'documentation',
    )
    expect(await (await app.request('https://app.example.com/', undefined, env)).text()).toBe(
      'application',
    )
    expect(await (await app.request('https://docs.example.com/guide', undefined, env)).text()).toBe(
      'documentation',
    )
    expect(
      await (await app.request('https://docs.example.com/api/auth', undefined, env)).json(),
    ).toEqual({ route: 'application-auth-root' })
    expect(
      await (
        await app.request(
          'https://docs.example.com/api/auth/token',
          {
            method: 'POST',
          },
          env,
        )
      ).json(),
    ).toEqual({ token: 'application-auth' })
    expect(requested).toEqual([
      '/_documentation-root/manifest.json',
      '/_documentation-root/index.html',
      '/_documentation-root/',
      '/_documentation-root/manifest.json',
      '/_documentation-root/guide/index.html',
      '/_documentation-root/guide/',
    ])
  })

  it('leaves /docs available to the app when no compiled manifest exists', async () => {
    const app = new Hono<{ Bindings: DeepSpaceDocumentationRouteEnv }>()
    registerDeepSpaceDocumentation(app, { resolveAuth: async () => null })
    app.get('/docs/*', (c) => c.text('application'))
    const env = {
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
    } as unknown as DeepSpaceDocumentationRouteEnv

    expect(await (await app.request('https://app.test/docs/fallback', undefined, env)).text()).toBe(
      'application',
    )
  })

  it('publishes root-relative MCP discovery only on the configured domain', async () => {
    const requested: string[] = []
    const app = new Hono<{ Bindings: DeepSpaceDocumentationRouteEnv }>()
    registerDeepSpaceDocumentation(app, {
      resolveAuth: async () => null,
      config: { domains: ['docs.example.com'] },
    })
    const env = {
      ASSETS: {
        fetch: async (request: Request | string) => {
          const pathname = new URL(typeof request === 'string' ? request : request.url).pathname
          requested.push(pathname)
          if (pathname.endsWith('/manifest.json')) {
            return Response.json({
              version: 2,
              sourceHash: 'source',
              name: 'Example',
              routes: ['/'],
              resources: [],
              assistant: { access: 'disabled' },
              mcp: { access: 'public' },
            })
          }
          if (pathname.endsWith('/skill.md')) return new Response('# Example skill')
          return new Response(null, { status: 404 })
        },
      },
    } as unknown as DeepSpaceDocumentationRouteEnv

    const response = await app.request('https://docs.example.com/.well-known/mcp', undefined, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      transport: { url: 'https://docs.example.com/mcp' },
    })
    const resource = await app.request(
      'https://docs.example.com/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'resources/read',
          params: { uri: 'https://docs.example.com/skill.md' },
        }),
      },
      env,
    )
    expect(resource.status).toBe(200)
    expect(await resource.json()).toMatchObject({
      result: {
        contents: [{ uri: 'https://docs.example.com/skill.md', text: '# Example skill' }],
      },
    })
    expect(
      (await app.request('https://app.example.com/.well-known/mcp', undefined, env)).status,
    ).toBe(404)
    expect(requested).toContain('/_documentation-root/skill.md')
    expect(requested).not.toContain('/_documentation/skill.md')
  })
})
