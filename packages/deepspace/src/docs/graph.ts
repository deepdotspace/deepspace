import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { loadDocsConfig, type LoadedDocsConfig } from './config'
import { parseMarkdown, slugify } from './markdown'
import { parseMdx } from './mdx'
import { operationMarkdown, parseOpenApi } from './openapi'
import { normalizeRoute, routeFromRelativePath } from './routing'
import {
  DocsError,
  type DocsConfig,
  type DocsDiagnostic,
  type DocsGraph,
  type DocsNavigationItem,
  type DocsNavigationNode,
  type DocsPage,
  type DocsValidationResult,
} from './types'

export function validateDocs(appDir: string): DocsValidationResult {
  const loaded = loadDocsConfig(appDir)
  if (!existsSync(loaded.sourceDir)) {
    throw new DocsError(
      `Documentation source directory not found: ${loaded.config.source}`,
      'docs_source_missing',
      [{ code: 'source_missing', message: loaded.config.source, file: loaded.sourceDir }],
    )
  }
  const warnings: DocsDiagnostic[] = [...loaded.warnings]
  const contentFiles = collectContentFiles(loaded.sourceDir)
  const sourceFiles = contentFiles.filter((path) => ['.md', '.mdx'].includes(extname(path).toLowerCase()))
  if (sourceFiles.length === 0 && loaded.config.openapi.length === 0) {
    throw new DocsError(
      `No .md or .mdx pages found in ${loaded.config.source}`,
      'docs_pages_missing',
      [{ code: 'pages_missing', message: loaded.config.source, file: loaded.sourceDir }],
    )
  }

  const pages = sourceFiles.map((sourcePath) => pageFromSource(loaded, sourcePath))
  const openApiHashes: string[] = []
  const openApiGroups: DocsNavigationNode[] = []
  for (const openapiConfig of loaded.config.openapi) {
    const api = parseOpenApi(resolve(appDir), openapiConfig)
    openApiHashes.push(api.raw)
    const apiPages = api.operations.map((operation) => {
      const markdown = operationMarkdown(operation)
      const parsed = parseMarkdown(markdown, `${api.sourcePath}#${operation.operationId}`)
      return {
        sourcePath: api.sourcePath,
        relativePath: `${relative(resolve(appDir), api.sourcePath)}#${operation.operationId}`,
        route: joinRoute(api.route, operation.operationId),
        title: operation.summary,
        description: operation.description,
        hidden: false,
        noindex: loaded.config.seo.noindex === true,
        markdown,
        html: parsed.html,
        text: parsed.text,
        headings: parsed.headings,
        sourceFormat: 'generated' as const,
        kind: 'openapi' as const,
        openapi: operation,
      } satisfies DocsPage
    })
    pages.push(...apiPages)
    openApiGroups.push({
      kind: 'group',
      label: api.title,
      items: apiPages.map((page) => ({ kind: 'page', route: page.route, label: page.title })),
    })
  }

  assertUniqueRoutes(pages)
  const byRoute = new Map(pages.map((page) => [page.route, page]))
  const navigation = loaded.config.navigation
    ? normalizeNavigation(loaded.config.navigation, byRoute, loaded.config)
    : automaticNavigation(pages.filter((page) => page.kind === 'page'))
  navigation.push(...openApiGroups)
  assertNavigationCoverage(navigation, pages, loaded.config)
  validatePageLinks(pages, byRoute, loaded.config.redirects)
  validateRedirectTargets(loaded.config, byRoute)

  const hash = createHash('sha256')
  hash.update(loaded.raw)
  for (const contentPath of contentFiles) {
    hash.update(relative(resolve(appDir), contentPath).split(sep).join('/'))
    hash.update(readFileSync(contentPath))
  }
  for (const raw of openApiHashes) hash.update(raw)
  const graph: DocsGraph = {
    config: loaded.config,
    pages: pages.sort((a, b) => a.route.localeCompare(b.route)),
    navigation,
    sourceHash: hash.digest('hex'),
  }
  return {
    appDir: resolve(appDir),
    configPath: loaded.configPath,
    sourceDir: loaded.sourceDir,
    outputDir: loaded.outputDir,
    graph,
    warnings,
  }
}

function pageFromSource(loaded: LoadedDocsConfig, sourcePath: string): DocsPage {
  const source = readFileSync(sourcePath, 'utf8')
  const relativePath = relative(loaded.sourceDir, sourcePath).split(sep).join('/')
  const rewritten = rewriteLocalReferences(source, relativePath, loaded.sourceDir, sourcePath)
  const sourceFormat = extname(sourcePath).toLowerCase() === '.mdx' ? 'mdx' : 'markdown'
  const parsed = sourceFormat === 'mdx'
    ? parseMdx(rewritten, sourcePath)
    : parseMarkdown(rewritten, sourcePath)
  const route = parsed.frontmatter.slug
    ? normalizeRoute(parsed.frontmatter.slug)
    : routeFromRelativePath(relativePath)
  const title = parsed.frontmatter.title
    ?? parsed.headings.find((heading) => heading.depth === 1)?.text
    ?? titleFromFile(relativePath)
  return {
    sourcePath,
    relativePath,
    route,
    title,
    description: parsed.frontmatter.description,
    hidden: parsed.frontmatter.hidden === true,
    noindex: loaded.config.seo.noindex === true || parsed.frontmatter.noindex === true,
    markdown: parsed.markdown,
    html: parsed.html,
    text: parsed.text,
    headings: parsed.headings,
    sourceFormat,
    kind: 'page',
  }
}

function collectContentFiles(sourceDir: string): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new DocsError(
          `Documentation content may not contain symbolic links: ${path}`,
          'docs_source_unsafe',
          [{ code: 'source_symlink', message: path, file: path }],
        )
      }
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  walk(sourceDir)
  return files.sort()
}

function normalizeNavigation(
  items: DocsNavigationItem[],
  pages: Map<string, DocsPage>,
  config: DocsConfig,
): DocsNavigationNode[] {
  return items.map((item): DocsNavigationNode => {
    if (typeof item === 'string') {
      const route = navigationReferenceToRoute(item)
      const page = pages.get(route)
      if (!page) {
        throw new DocsError(
          `Navigation references a missing page: ${item}`,
          'docs_navigation_invalid',
          [{ code: 'navigation_missing_page', message: item }],
        )
      }
      return { kind: 'page', route, label: page.title }
    }
    if ('group' in item) {
      return {
        kind: 'group',
        label: item.group,
        items: normalizeNavigation(item.pages, pages, config),
      }
    }
    if (!isSafeLink(item.href)) {
      throw new DocsError(
        `Unsafe navigation link: ${item.href}`,
        'docs_navigation_invalid',
        [{ code: 'navigation_unsafe_link', message: item.href }],
      )
    }
    if (item.href.startsWith('/')) {
      const route = normalizeRoute(item.href)
      if (!pages.has(route) && !config.redirects[route]) {
        throw new DocsError(
          `Navigation link points to an unknown internal route: ${item.href}`,
          'docs_navigation_invalid',
          [{ code: 'navigation_missing_route', message: item.href }],
        )
      }
      return { kind: 'link', href: route, label: item.label }
    }
    return { kind: 'link', href: item.href, label: item.label }
  })
}

function automaticNavigation(pages: DocsPage[]): DocsNavigationNode[] {
  return pages
    .filter((page) => !page.hidden)
    .sort((a, b) => a.route.localeCompare(b.route))
    .map((page) => ({ kind: 'page', route: page.route, label: page.title }))
}

function assertNavigationCoverage(
  navigation: DocsNavigationNode[],
  pages: DocsPage[],
  config: DocsConfig,
): void {
  if (!config.navigation) return
  const routes = new Set<string>()
  const visit = (nodes: DocsNavigationNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'page') routes.add(node.route)
      else if (node.kind === 'group') visit(node.items)
    }
  }
  visit(navigation)
  const orphaned = pages.filter((page) => page.kind === 'page' && !page.hidden && !routes.has(page.route))
  if (orphaned.length > 0) {
    throw new DocsError(
      `${orphaned.length} public page(s) are missing from navigation`,
      'docs_navigation_incomplete',
      orphaned.map((page) => ({
        code: 'navigation_orphan',
        message: page.route,
        file: page.sourcePath,
      })),
    )
  }
}

function validatePageLinks(
  pages: DocsPage[],
  byRoute: Map<string, DocsPage>,
  redirects: Record<string, string>,
): void {
  const diagnostics: DocsDiagnostic[] = []
  for (const page of pages) {
    if (page.kind !== 'page') continue
    const pattern = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
    for (const match of page.markdown.matchAll(pattern)) {
      const isImage = match[1] === '!'
      const href = match[2]
      if (isImage || href.startsWith('/_docs/media/')) continue
      if (/^(?:https?:|mailto:|#|data:)/i.test(href)) continue
      const routePart = href.split('#')[0].split('?')[0]
      if (!routePart) continue
      const target = routePart.startsWith('/')
        ? normalizeRoute(routePart)
        : normalizeRoute(posix.join(dirname(page.route), routePart))
      const normalized = navigationReferenceToRoute(target)
      if (!byRoute.has(normalized) && !redirects[normalized]) {
        diagnostics.push({
          code: 'broken_internal_link',
          message: `${href} resolves to ${normalized}`,
          file: page.sourcePath,
          line: page.markdown.slice(0, match.index).split('\n').length,
        })
      }
    }
  }
  if (diagnostics.length > 0) {
    throw new DocsError(
      `${diagnostics.length} broken internal documentation link(s)`,
      'docs_links_invalid',
      diagnostics,
    )
  }
}

export function rewriteLocalReferences(
  source: string,
  relativePath: string,
  sourceDir: string,
  sourcePath: string,
): string {
  const pageDirectory = posix.dirname(relativePath)
  return source.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+["'][^"']*["'])?)\)/g,
    (match, imageMarker: string, label: string, href: string, title: string) => {
      if (/^(?:https?:|mailto:|data:|#)/i.test(href)) return match
      const [pathPart, suffix = ''] = href.split(/(?=[?#])/)
      if (!pathPart) return match
      const relativeTarget = pathPart.startsWith('/')
        ? pathPart.replace(/^\//, '')
        : posix.normalize(posix.join(pageDirectory, pathPart))
      if (relativeTarget === '..' || relativeTarget.startsWith('../')) {
        throw new DocsError(
          `Documentation reference escapes the source directory: ${href}`,
          'docs_link_unsafe',
          [{ code: 'link_path_escape', message: href, file: sourcePath }],
        )
      }
      const absoluteTarget = resolve(sourceDir, relativeTarget)
      if (imageMarker === '!') {
        if (!existsSync(absoluteTarget)) {
          throw new DocsError(
            `Documentation image not found: ${href}`,
            'docs_asset_missing',
            [{ code: 'asset_missing', message: href, file: sourcePath }],
          )
        }
        return `![${label}](/_docs/media/${relativeTarget}${suffix}${title})`
      }
      if (/\.(?:md|mdx)$/i.test(relativeTarget)) {
        return `[${label}](${routeFromRelativePath(relativeTarget)}${suffix}${title})`
      }
      const markdownTarget = [
        `${absoluteTarget}.mdx`,
        `${absoluteTarget}.md`,
        join(absoluteTarget, 'index.mdx'),
        join(absoluteTarget, 'index.md'),
      ].find(existsSync)
      if (markdownTarget) {
        const targetRelative = relative(sourceDir, markdownTarget).split(sep).join('/')
        return `[${label}](${routeFromRelativePath(targetRelative)}${suffix}${title})`
      }
      if (existsSync(absoluteTarget)) {
        return `[${label}](/_docs/media/${relativeTarget}${suffix}${title})`
      }
      return match
    },
  )
}

function validateRedirectTargets(config: DocsConfig, byRoute: Map<string, DocsPage>): void {
  for (const [from, to] of Object.entries(config.redirects)) {
    const normalizedFrom = normalizeRoute(from)
    if (byRoute.has(normalizedFrom)) {
      throw new DocsError(
        `Redirect source collides with a page: ${from}`,
        'docs_redirect_invalid',
        [{ code: 'redirect_page_collision', message: from }],
      )
    }
    const finalTarget = followRedirects(to, config.redirects)
    if (!byRoute.has(normalizeRoute(finalTarget))) {
      throw new DocsError(
        `Redirect target does not exist: ${from} -> ${to}`,
        'docs_redirect_invalid',
        [{ code: 'redirect_missing_target', message: `${from} -> ${to}` }],
      )
    }
  }
}

function followRedirects(route: string, redirects: Record<string, string>): string {
  let cursor = route
  const seen = new Set<string>()
  while (redirects[cursor] && !seen.has(cursor)) {
    seen.add(cursor)
    cursor = redirects[cursor]
  }
  return cursor
}

function assertUniqueRoutes(pages: DocsPage[]): void {
  const seen = new Map<string, DocsPage>()
  for (const page of pages) {
    const existing = seen.get(page.route)
    if (existing) {
      throw new DocsError(
        `Multiple documentation pages resolve to ${page.route}`,
        'docs_route_collision',
        [existing, page].map((candidate) => ({
          code: 'route_collision',
          message: candidate.route,
          file: candidate.sourcePath,
        })),
      )
    }
    if (page.route.startsWith('/_docs') || page.route.startsWith('/api/')) {
      throw new DocsError(
        `Documentation route uses a reserved prefix: ${page.route}`,
        'docs_route_reserved',
        [{ code: 'reserved_route', message: page.route, file: page.sourcePath }],
      )
    }
    seen.set(page.route, page)
  }
}

function navigationReferenceToRoute(value: string): string {
  return normalizeRoute(value)
}

function titleFromFile(relativePath: string): string {
  const stem = basename(relativePath, extname(relativePath))
  const candidate = stem.toLowerCase() === 'index' ? basename(dirname(relativePath)) : stem
  if (!candidate || candidate === '.') return 'Overview'
  return candidate.split(/[-_]/).filter(Boolean).map(capitalize).join(' ')
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function joinRoute(left: string, right: string): string {
  return normalizeRoute(`${left}/${slugify(right)}`)
}

function isSafeLink(value: string): boolean {
  return /^(?:https?:\/\/|mailto:|\/|#)/i.test(value)
}
