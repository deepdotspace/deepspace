import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  docsDevHeaders,
  docsMimeType as resolveDocsMimeType,
  isWithinPath,
} from '../../../docs/dev-http'

const IGNORED_WATCH_SEGMENTS = new Set([
  '.cache',
  '.deepspace',
  '.git',
  '.wrangler',
  'blob-report',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
])

export function serveStatic(
  outputDir: string,
  requestUrl: string,
  response: import('node:http').ServerResponse,
): void {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://docs.local').pathname)
  // The deployed dispatcher preserves requests already in the reserved
  // `/_docs/` namespace. Mirror that contract locally while still exposing
  // public documentation routes such as `/guides/quickstart` at the root.
  const publicPath = pathname.startsWith('/_docs/') ? pathname.slice('/_docs'.length) : pathname
  const relativePath = publicPath.replace(/^\/+/, '')
  const candidates = relativePath ? [relativePath, `${relativePath}/index.html`] : ['index.html']
  const selected =
    candidates
      .map((candidate) => resolve(outputDir, candidate))
      .find(
        (candidate) =>
          isWithinPath(outputDir, candidate) &&
          existsSync(candidate) &&
          statSync(candidate).isFile(),
      ) ?? join(outputDir, '404.html')
  const body = readFileSync(selected)
  response.writeHead(
    selected.endsWith('404.html') ? 404 : 200,
    docsDevHeaders(selected, 'text/html; charset=utf-8'),
  )
  response.end(body)
}

export function shouldIgnoreWatchPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => IGNORED_WATCH_SEGMENTS.has(part))
}

export function docsMimeType(path: string): string {
  return resolveDocsMimeType(path, 'text/html; charset=utf-8')
}
