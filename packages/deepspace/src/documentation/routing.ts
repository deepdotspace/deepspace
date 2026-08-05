import { DocumentationError } from './types'

/** Slash-collapsing shared by the compiler's strict normalizer and the
 * worker's lenient normalizer for untrusted lookup input, which must miss
 * rather than throw. */
export function collapseRoute(value: string): string {
  let route = `/${value}`.replace(/\/{2,}/g, '/')
  if (route.length > 1) route = route.replace(/\/$/, '')
  return route
}

/** Normalize and validate every public documentation route in one place. */
export function normalizeRoute(value: string): string {
  assertSafeRoute(value)
  let route = collapseRoute(value)
  route = route.replace(/\.(?:md|mdx)$/i, '')
  route = route.replace(/\/index$/i, '')
  return route || '/'
}

export function routeFromRelativePath(relativePath: string): string {
  let path = relativePath.replace(/\.(?:md|mdx)$/i, '')
  if (path === 'index') path = ''
  else path = path.replace(/\/index$/i, '')
  return normalizeRoute(path)
}

/** Normalize the public mount for native documentation. Empty means a custom documentation host. */
export function normalizeDocumentationBasePath(value: string | undefined): string {
  if (!value || value === '/') return ''
  const normalized = normalizeRoute(value)
  if (normalized === '/_documentation') {
    throw new DocumentationError('The internal /_documentation namespace cannot be a public documentation base', 'documentation_base_invalid')
  }
  return normalized
}

/** Convert a logical documentation route/resource into its public URL path. */
export function documentationPublicPath(basePath: string, path: string): string {
  const base = normalizeDocumentationBasePath(basePath)
  const suffix = path.startsWith('/') ? path : `/${path}`
  if (suffix === '/') return base || '/'
  return `${base}${suffix}`
}

/** Project logical root-relative references onto the active public mount. */
export function publicDocumentationReferences(source: string, basePath: string): string {
  const base = normalizeDocumentationBasePath(basePath)
  if (!base) return source
  const publicPath = (value: string): string =>
    value === base || value.startsWith(`${base}/`) ? value : `${base}${value}`
  return source
    .replace(
      /(\]\()(\/(?!\/)[^)\s]*)/g,
      (_match, prefix: string, value: string) => `${prefix}${publicPath(value)}`,
    )
    .replace(
      /^(\s*\[[^\]]+\]:\s*)(\/(?!\/)\S*)/gm,
      (_match, prefix: string, value: string) => `${prefix}${publicPath(value)}`,
    )
    .replace(
      /(\b(?:href|src)=["'])(\/(?!\/)[^"']*)/g,
      (_match, prefix: string, value: string) => `${prefix}${publicPath(value)}`,
    )
}

/** Convert a public request pathname back to a logical documentation route. */
export function documentationLogicalPath(basePath: string, pathname: string): string | null {
  const base = normalizeDocumentationBasePath(basePath)
  if (!base) return pathname.startsWith('/') ? pathname : `/${pathname}`
  if (pathname === base) return '/'
  if (!pathname.startsWith(`${base}/`)) return null
  return pathname.slice(base.length) || '/'
}

/** Canonical public Markdown projection for a page route. */
export function markdownUrlForRoute(route: string, basePath = ''): string {
  const logical = route === '/' ? '/index.md' : `${normalizeRoute(route)}.md`
  return documentationPublicPath(basePath, logical)
}

/** Deterministic build artifact paths for one canonical page route. */
export function artifactPathsForRoute(route: string): {
  data: string
  html: string
  markdown: string
} {
  const clean = normalizeRoute(route).replace(/^\//, '')
  return clean
    ? {
        data: `data/${clean}.json`,
        html: `${clean}/index.html`,
        markdown: `${clean}.md`,
      }
    : {
        data: 'data/index.json',
        html: 'index.html',
        markdown: 'index.md',
      }
}

export function routeArtifactId(route: string): string {
  return route === '/'
    ? 'index'
    : normalizeRoute(route).replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-')
}

export function joinSiteUrl(base: string, route: string): string {
  const path = route.startsWith('/') ? route : `/${route}`
  return `${base.replace(/\/$/, '')}${path}`
}

function assertSafeRoute(value: string): void {
  if (value.includes('\\') || value.includes('\0')) throw unsafeRoute(value)

  let decoded = value
  for (let pass = 0; pass < 5; pass++) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      throw unsafeRoute(value)
    }
    if (next === decoded) break
    decoded = next
  }
  if (
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.split('/').some((segment) => segment === '.' || segment === '..')
  ) throw unsafeRoute(value)
}

function unsafeRoute(value: string): DocumentationError {
  return new DocumentationError(
    `Documentation route contains an unsafe path segment: ${value}`,
    'documentation_route_invalid',
    [{ code: 'route_path_escape', message: value }],
  )
}
