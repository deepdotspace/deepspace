import { describe, expect, it } from 'vitest'
import { resolveExtraRunWorkerFirstRoutes } from '../build'

describe('native docs deployment routes', () => {
  it('derives reserved docs routes without requiring app configuration', () => {
    expect(resolveExtraRunWorkerFirstRoutes({
      assets: { run_worker_first: ['/api/*', '/custom/*'] },
    }, true)).toEqual([
      '/custom/*',
      '/mcp',
      '/.well-known/mcp*',
      '/*.md',
    ])
  })

  it('deduplicates explicit routes and leaves non-docs deployments alone', () => {
    const config = {
      assets: {
        run_worker_first: ['/mcp', '/mcp', '/.well-known/mcp*', '/*.md'],
      },
    }
    expect(resolveExtraRunWorkerFirstRoutes(config, true)).toEqual([
      '/mcp',
      '/.well-known/mcp*',
      '/*.md',
    ])
    expect(resolveExtraRunWorkerFirstRoutes(config, false)).toEqual([
      '/mcp',
      '/.well-known/mcp*',
      '/*.md',
    ])
  })
})
