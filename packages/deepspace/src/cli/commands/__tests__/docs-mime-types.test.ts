import { describe, expect, it } from 'vitest'
import { docsMimeType } from '../docs.js'
import { shouldIgnoreWatchPath } from '../docs/dev-server.js'

describe('docs asset MIME types', () => {
  it.each([
    ['font.woff', 'font/woff'],
    ['font.woff2', 'font/woff2'],
    ['image.avif', 'image/avif'],
    ['image.gif', 'image/gif'],
    ['favicon.ico', 'image/x-icon'],
    ['route-without-an-extension', 'text/html; charset=utf-8'],
  ])('serves %s with %s', (path, expected) => {
    expect(docsMimeType(path)).toBe(expected)
  })
})

describe('docs dev input watcher', () => {
  it.each([
    'dist/_docs/index.html',
    'node_modules/deepspace/dist/docs.js',
    'test-results/docs-native/trace.zip',
    'playwright-report/index.html',
    'blob-report/report.zip',
    'coverage/index.html',
    '.cache/compiler.json',
  ])('ignores generated path %s', (path) => {
    expect(shouldIgnoreWatchPath(path)).toBe(true)
  })

  it.each(['docs.json', 'content/index.mdx', 'docs.tsx', 'src/docs/Example.tsx'])(
    'watches authored input %s',
    (path) => {
      expect(shouldIgnoreWatchPath(path)).toBe(false)
    },
  )
})
