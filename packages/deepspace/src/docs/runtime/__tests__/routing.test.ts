import { describe, expect, it } from 'vitest'
import { shouldHandleDocsNavigation } from '../routing'

describe('documentation client routing', () => {
  it('handles authored documentation routes and query/hash variants', () => {
    for (const href of ['/get-started', '/sdk?tab=worker', '/guide#install', '/guides/v1.0']) {
      expect(shouldHandleDocsNavigation(href), href).toBe(true)
    }
  })

  it('leaves resources and protocol endpoints to the browser', () => {
    for (const href of [
      '/guide.md', '/llms.txt', '/skill.md', '/mcp', '/favicon.ico', '/image.png',
      '/archive.zip', '/_docs/data/guide.json', '/api/ai/docs',
      '/.well-known/agent-skills/index.json', '//example.com/guide',
      'https://example.com/guide', '#install',
    ]) {
      expect(shouldHandleDocsNavigation(href), href).toBe(false)
    }
  })
})
