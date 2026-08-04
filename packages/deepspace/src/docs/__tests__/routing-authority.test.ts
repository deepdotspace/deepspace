import { describe, expect, it } from 'vitest'
import {
  artifactPathsForRoute,
  joinSiteUrl,
  markdownUrlForRoute,
  normalizeRoute,
  routeFromRelativePath,
} from '../routing'

describe('documentation route authority', () => {
  it('derives public and build paths from one normalized route', () => {
    expect(normalizeRoute('/guides/start.mdx/')).toBe('/guides/start')
    expect(routeFromRelativePath('guides/start.mdx')).toBe('/guides/start')
    expect(markdownUrlForRoute('/guides/start')).toBe('/guides/start.md')
    expect(artifactPathsForRoute('/guides/start')).toEqual({
      data: 'data/guides/start.json',
      html: 'guides/start/index.html',
      markdown: 'guides/start.md',
    })
    expect(artifactPathsForRoute('/')).toEqual({
      data: 'data/index.json',
      html: 'index.html',
      markdown: 'index.md',
    })
    expect(joinSiteUrl('https://docs.example.com/', '/guides/start')).toBe(
      'https://docs.example.com/guides/start',
    )
  })

  it('rejects encoded path traversal for every consumer', () => {
    expect(() => normalizeRoute('/guides/%252e%252e/secrets')).toThrow(/unsafe path segment/)
    expect(() => artifactPathsForRoute('/guides/../secrets')).toThrow(/unsafe path segment/)
  })
})
