import { Hono } from 'hono'
import {
  registerDocumentationAssistantRoutes,
  registerDocumentationStaticRoutes,
  type DocumentationAssistantRouteEnv,
} from './assistant-routes'
import { registerDocumentationMcpRoutes, type DocumentationMcpRouteEnv } from './mcp-routes'

export interface DeepSpaceDocumentationRouteEnv
  extends DocumentationAssistantRouteEnv, DocumentationMcpRouteEnv {}

export interface DeepSpaceDocumentationRouteOptions<Env extends DeepSpaceDocumentationRouteEnv> {
  resolveAuth: (request: Request, env: Env) => Promise<unknown | null>
  config?: { domains?: readonly string[]; [key: string]: unknown }
}

/** Register the complete native documentation protocol surface in its required order. */
export function registerDeepSpaceDocumentation<Env extends DeepSpaceDocumentationRouteEnv>(
  app: Hono<{ Bindings: Env }>,
  options: DeepSpaceDocumentationRouteOptions<Env>,
): void {
  app.use('*', async (c, next) =>
    isPrivateDocumentationPath(new URL(c.req.url).pathname) ? c.notFound() : next(),
  )
  const domains = new Set(
    options.config?.domains?.map((domain) => domain.trim().toLowerCase()) ?? [],
  )
  if (domains.size) {
    const root = new Hono<{ Bindings: Env }>()
    registerDocumentationAssistantRoutes(root, options.resolveAuth, '', '/_documentation-root')
    registerDocumentationMcpRoutes(root, '', '/_documentation-root')
    registerDocumentationStaticRoutes(root, '', '/_documentation-root')
    app.all('*', (c, next) => {
      const url = new URL(c.req.url)
      if (
        !domains.has(url.hostname.toLowerCase()) ||
        url.pathname === '/api/auth' ||
        url.pathname.startsWith('/api/auth/')
      )
        return next()
      return root.fetch(c.req.raw, c.env)
    })
  }
  registerDocumentationAssistantRoutes(app, options.resolveAuth)
  registerDocumentationMcpRoutes(app)
  registerDocumentationStaticRoutes(app)
}

function isPrivateDocumentationPath(pathname: string): boolean {
  // Reject every spelling that could reach the private namespace after any
  // downstream decode or slash normalization: fully percent-decode (bounded,
  // so `%252F` collapses through `%2F` to `/`), then collapse repeated
  // slashes. Public compiled routes never decode into `/_documentation`, so
  // over-rejection is impossible.
  let decoded = pathname
  for (let round = 0; round < 3; round += 1) {
    const next = decoded.replace(/%([0-9a-f]{2})/giu, (_sequence, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    if (next === decoded) break
    decoded = next
  }
  return /^\/_documentation(?:-root)?(?:\/|$)/u.test(decoded.replace(/\/{2,}/gu, '/'))
}
