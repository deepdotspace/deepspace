import { extname, relative, resolve, sep } from 'node:path'

const DOCS_DEV_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https:; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

export function isWithinPath(root: string, candidate: string): boolean {
  if (!root) return false
  const path = relative(resolve(root), resolve(candidate))
  return path !== '..' && !path.startsWith(`..${sep}`)
}

export function docsDevHeaders(
  path: string,
  fallbackMimeType = 'application/octet-stream',
): Record<string, string> {
  return {
    'Content-Type': docsMimeType(path, fallbackMimeType),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': DOCS_DEV_CONTENT_SECURITY_POLICY,
  }
}

export function docsMimeType(path: string, fallback = 'application/octet-stream'): string {
  switch (extname(path).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.md':
      return 'text/markdown; charset=utf-8'
    case '.txt':
      return 'text/plain; charset=utf-8'
    case '.xml':
      return 'application/xml; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.avif':
      return 'image/avif'
    case '.gif':
      return 'image/gif'
    case '.ico':
      return 'image/x-icon'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.woff':
      return 'font/woff'
    case '.woff2':
      return 'font/woff2'
    default:
      return fallback
  }
}
