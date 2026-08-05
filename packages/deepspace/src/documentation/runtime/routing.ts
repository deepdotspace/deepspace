import { documentationLogicalPath } from '../routing'
import { isNativeDocumentationResourcePath } from '../resource-path'

const RESOURCE_ROUTES = new Set(['/mcp'])
const RESOURCE_PREFIXES = ['/api/', '/assets/', '/data/', '/media/', '/.well-known/'] as const

/** Return true only for pages compiled into the client-side documentation graph. */
export function shouldHandleDocumentationNavigation(href: string, basePath = '/docs'): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false
  const pathname = href.split(/[?#]/, 1)[0] ?? ''
  const logical = documentationLogicalPath(basePath, pathname)
  if (!logical || RESOURCE_ROUTES.has(logical)) return false
  if (RESOURCE_PREFIXES.some((prefix) => logical.startsWith(prefix))) return false
  return !isNativeDocumentationResourcePath(logical)
}
