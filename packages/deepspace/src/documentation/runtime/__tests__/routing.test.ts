import { describe, expect, it } from 'vitest'
import { shouldHandleDocumentationNavigation } from '../routing'

describe('documentation client routing', () => {
  it('handles authored documentation routes and query/hash variants', () => {
    for (const href of ['/docs/get-started', '/docs/sdk?tab=worker', '/docs/guide#install', '/docs/guides/v1.0']) {
      expect(shouldHandleDocumentationNavigation(href, '/docs'), href).toBe(true)
    }
    expect(shouldHandleDocumentationNavigation('/guide#install', '')).toBe(true)
  })

  it('leaves resources and protocol endpoints to the browser', () => {
    for (const href of [
      '/docs/guide.md', '/docs/llms.txt', '/docs/skill.md', '/docs/mcp',
      '/docs/favicon.ico', '/docs/image.png', '/docs/archive.zip',
      '/docs/data/guide.json', '/docs/api/ai', '/guide',
      '/docs/.well-known/agent-skills/index.json', '//example.com/guide',
      'https://example.com/guide', '#install',
    ]) {
      expect(shouldHandleDocumentationNavigation(href, '/docs'), href).toBe(false)
    }
  })
})
