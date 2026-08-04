import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  docsAssistantLimiterManifestEntry,
  registerDeepSpaceDocs,
  type DeepSpaceDocsRouteEnv,
} from '../docs-routes'

describe('native documentation route facade', () => {
  it('registers every docs protocol through one ordered app call', () => {
    const app = new Hono<{ Bindings: DeepSpaceDocsRouteEnv }>()
    registerDeepSpaceDocs(app, { resolveAuth: async () => null })

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /api/ai/docs',
      'GET /mcp',
      'POST /mcp',
      'GET /.well-known/mcp',
      'GET /.well-known/mcp.json',
      'GET /.well-known/mcp/server-card.json',
      'GET /.well-known/mcp/server-cards.json',
      'GET /_docs/*',
    ])
  })

  it('derives the limiter manifest entry from its app-owned class name', () => {
    expect(docsAssistantLimiterManifestEntry('AppDocsAssistantLimiter')).toEqual({
      binding: 'DOCS_ASSISTANT_LIMITER',
      className: 'AppDocsAssistantLimiter',
      sqlite: true,
    })
  })
})
