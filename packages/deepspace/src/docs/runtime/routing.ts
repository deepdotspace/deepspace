import { isDocsResourcePath } from '../../shared/docs-routing'

const RESOURCE_ROUTES = new Set(['/mcp'])
const RESOURCE_PREFIXES = ['/api/', '/_docs/', '/.well-known/'] as const

/** Return true only for pages compiled into the client-side documentation graph. */
export function shouldHandleDocsNavigation(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false
  const pathname = href.split(/[?#]/, 1)[0] ?? ''
  if (RESOURCE_ROUTES.has(pathname)) return false
  if (RESOURCE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false
  return !isDocsResourcePath(pathname)
}
