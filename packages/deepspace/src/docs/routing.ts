import { DocsError } from './types'

/** Normalize and validate every public documentation route in one place. */
export function normalizeRoute(value: string): string {
  assertSafeRoute(value)
  let route = `/${value}`.replace(/\/{2,}/g, '/')
  if (route.length > 1) route = route.replace(/\/$/, '')
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

/** Canonical public Markdown projection for a page route. */
export function markdownUrlForRoute(route: string): string {
  return route === '/' ? '/index.md' : `${normalizeRoute(route)}.md`
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

function unsafeRoute(value: string): DocsError {
  return new DocsError(
    `Documentation route contains an unsafe path segment: ${value}`,
    'docs_route_invalid',
    [{ code: 'route_path_escape', message: value }],
  )
}
