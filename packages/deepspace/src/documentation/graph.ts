import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { loadDocumentationConfig, type LoadedDocumentationConfig } from './config'
import { parseMarkdown, slugify, stripFirstMarkdownH1 } from './markdown'
import { parseMdx } from './mdx'
import { operationMarkdown, parseOpenApi } from './openapi'
import { normalizeRoute, routeFromRelativePath } from './routing'
import {
  DocumentationError,
  type DocumentationConfig,
  type DocumentationDiagnostic,
  type DocumentationGraph,
  type DocumentationNavigationItem,
  type DocumentationNavigationNode,
  type DocumentationPage,
  type DocumentationValidationResult,
} from './types'

export function validateDocumentation(appDir: string): DocumentationValidationResult {
  const loaded = loadDocumentationConfig(appDir)
  if (!existsSync(loaded.sourceDir)) {
    throw new DocumentationError(
      `Documentation source directory not found: ${loaded.config.source}`,
      'documentation_source_missing',
      [{ code: 'source_missing', message: loaded.config.source, file: loaded.sourceDir }],
    )
  }
  const warnings: DocumentationDiagnostic[] = [...loaded.warnings]
  const contentFiles = collectContentFiles(loaded.sourceDir)
  const sourceFiles = contentFiles.filter((path) => ['.md', '.mdx'].includes(extname(path).toLowerCase()))
  if (sourceFiles.length === 0 && loaded.config.openapi.length === 0) {
    throw new DocumentationError(
      `No .md or .mdx pages found in ${loaded.config.source}`,
      'documentation_pages_missing',
      [{ code: 'pages_missing', message: loaded.config.source, file: loaded.sourceDir }],
    )
  }

  const pages = sourceFiles.map((sourcePath) => pageFromSource(loaded, sourcePath))
  const openApiHashes: string[] = []
  const openApiGroups: DocumentationNavigationNode[] = []
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
      } satisfies DocumentationPage
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
  const graph: DocumentationGraph = {
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

function pageFromSource(loaded: LoadedDocumentationConfig, sourcePath: string): DocumentationPage {
  const source = readFileSync(sourcePath, 'utf8')
  const relativePath = relative(loaded.sourceDir, sourcePath).split(sep).join('/')
  const rewritten = rewriteLocalReferences(source, relativePath, loaded.sourceDir, sourcePath)
  const sourceFormat = extname(sourcePath).toLowerCase() === '.mdx' ? 'mdx' : 'markdown'
  const authored = sourceFormat === 'mdx'
    ? parseMdx(rewritten, sourcePath)
    : parseMarkdown(rewritten, sourcePath)
  const route = authored.frontmatter.slug
    ? normalizeRoute(authored.frontmatter.slug)
    : routeFromRelativePath(relativePath)
  const title = authored.frontmatter.title
    ?? authored.headings.find((heading) => heading.depth === 1)?.text
    ?? titleFromFile(relativePath)
  const normalizedSource = stripFirstMarkdownH1(rewritten)
  const parsed = sourceFormat === 'mdx'
    ? parseMdx(normalizedSource, sourcePath)
    : parseMarkdown(normalizedSource, sourcePath)
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
        throw new DocumentationError(
          `Documentation content may not contain symbolic links: ${path}`,
          'documentation_source_unsafe',
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
  items: DocumentationNavigationItem[],
  pages: Map<string, DocumentationPage>,
  config: DocumentationConfig,
): DocumentationNavigationNode[] {
  return items.map((item): DocumentationNavigationNode => {
    if (typeof item === 'string') {
      const route = navigationReferenceToRoute(item)
      const page = pages.get(route)
      if (!page) {
        throw new DocumentationError(
          `Navigation references a missing page: ${item}`,
          'documentation_navigation_invalid',
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
      throw new DocumentationError(
        `Unsafe navigation link: ${item.href}`,
        'documentation_navigation_invalid',
        [{ code: 'navigation_unsafe_link', message: item.href }],
      )
    }
    if (item.href.startsWith('/')) {
      const route = normalizeRoute(item.href)
      if (!pages.has(route) && !config.redirects[route]) {
        throw new DocumentationError(
          `Navigation link points to an unknown internal route: ${item.href}`,
          'documentation_navigation_invalid',
          [{ code: 'navigation_missing_route', message: item.href }],
        )
      }
      return { kind: 'link', href: route, label: item.label }
    }
    return { kind: 'link', href: item.href, label: item.label }
  })
}

function automaticNavigation(pages: DocumentationPage[]): DocumentationNavigationNode[] {
  return pages
    .filter((page) => !page.hidden)
    .sort((a, b) => a.route.localeCompare(b.route))
    .map((page) => ({ kind: 'page', route: page.route, label: page.title }))
}

function assertNavigationCoverage(
  navigation: DocumentationNavigationNode[],
  pages: DocumentationPage[],
  config: DocumentationConfig,
): void {
  if (!config.navigation) return
  const routes = new Set<string>()
  const visit = (nodes: DocumentationNavigationNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'page') routes.add(node.route)
      else if (node.kind === 'group') visit(node.items)
    }
  }
  visit(navigation)
  const orphaned = pages.filter((page) => page.kind === 'page' && !page.hidden && !routes.has(page.route))
  if (orphaned.length > 0) {
    throw new DocumentationError(
      `${orphaned.length} public page(s) are missing from navigation`,
      'documentation_navigation_incomplete',
      orphaned.map((page) => ({
        code: 'navigation_orphan',
        message: page.route,
        file: page.sourcePath,
      })),
    )
  }
}

function validatePageLinks(
  pages: DocumentationPage[],
  byRoute: Map<string, DocumentationPage>,
  redirects: Record<string, string>,
): void {
  const diagnostics: DocumentationDiagnostic[] = []
  for (const page of pages) {
    if (page.kind !== 'page') continue
    const pattern = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
    for (const match of page.markdown.matchAll(pattern)) {
      const isImage = match[1] === '!'
      const href = match[2]
      if (isImage || href.startsWith('/media/')) continue
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
    throw new DocumentationError(
      `${diagnostics.length} broken internal documentation link(s)`,
      'documentation_links_invalid',
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
        throw new DocumentationError(
          `Documentation reference escapes the source directory: ${href}`,
          'documentation_link_unsafe',
          [{ code: 'link_path_escape', message: href, file: sourcePath }],
        )
      }
      const absoluteTarget = resolve(sourceDir, relativeTarget)
      if (imageMarker === '!') {
        if (!existsSync(absoluteTarget)) {
          throw new DocumentationError(
            `Documentation image not found: ${href}`,
            'documentation_asset_missing',
            [{ code: 'asset_missing', message: href, file: sourcePath }],
          )
        }
        return `![${label}](/media/${relativeTarget}${suffix}${title})`
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
        return `[${label}](/media/${relativeTarget}${suffix}${title})`
      }
      return match
    },
  )
}

function validateRedirectTargets(config: DocumentationConfig, byRoute: Map<string, DocumentationPage>): void {
  for (const [from, to] of Object.entries(config.redirects)) {
    const normalizedFrom = normalizeRoute(from)
    if (byRoute.has(normalizedFrom)) {
      throw new DocumentationError(
        `Redirect source collides with a page: ${from}`,
        'documentation_redirect_invalid',
        [{ code: 'redirect_page_collision', message: from }],
      )
    }
    const finalTarget = followRedirects(to, config.redirects)
    if (!byRoute.has(normalizeRoute(finalTarget))) {
      throw new DocumentationError(
        `Redirect target does not exist: ${from} -> ${to}`,
        'documentation_redirect_invalid',
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

function assertUniqueRoutes(pages: DocumentationPage[]): void {
  const seen = new Map<string, DocumentationPage>()
  for (const page of pages) {
    const existing = seen.get(page.route)
    if (existing) {
      throw new DocumentationError(
        `Multiple documentation pages resolve to ${page.route}`,
        'documentation_route_collision',
        [existing, page].map((candidate) => ({
          code: 'route_collision',
          message: candidate.route,
          file: candidate.sourcePath,
        })),
      )
    }
    if (
      ['/api', '/assets', '/data', '/media', '/mcp', '/.well-known'].some(
        (reserved) => page.route === reserved || page.route.startsWith(`${reserved}/`),
      )
    ) {
      throw new DocumentationError(
        `Documentation route uses a reserved prefix: ${page.route}`,
        'documentation_route_reserved',
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
