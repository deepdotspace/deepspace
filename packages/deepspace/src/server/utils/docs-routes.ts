import type { Hono } from 'hono'
import {
  registerDocsAssistantRoutes,
  registerDocsStaticRoutes,
  type DocsAssistantRouteEnv,
} from './docs-assistant-routes'
import { registerDocsMcpRoutes, type DocsMcpRouteEnv } from './docs-mcp-routes'

export interface DeepSpaceDocsRouteEnv extends DocsAssistantRouteEnv, DocsMcpRouteEnv {}

export interface DeepSpaceDocsRouteOptions<Env extends DeepSpaceDocsRouteEnv> {
  resolveAuth: (request: Request, env: Env) => Promise<unknown | null>
}

/** Register the complete native docs protocol surface in its required order. */
export function registerDeepSpaceDocs<Env extends DeepSpaceDocsRouteEnv>(
  app: Hono<{ Bindings: Env }>,
  options: DeepSpaceDocsRouteOptions<Env>,
): void {
  registerDocsAssistantRoutes(app, options.resolveAuth)
  registerDocsMcpRoutes(app)
  registerDocsStaticRoutes(app)
}

/** Canonical manifest entry for the public docs assistant/MCP concurrency limiter. */
export function docsAssistantLimiterManifestEntry<ClassName extends string>(className: ClassName) {
  return {
    binding: 'DOCS_ASSISTANT_LIMITER',
    className,
    sqlite: true,
  } as const
}
