import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { loadDocumentationConfig, type LoadedDocumentationConfig } from './config'
import { localizedRoute } from './locales'
import { mapOutsideCode, parseMarkdown, slugify, stripCodeForValidation, stripFirstMarkdownH1 } from './markdown'
import { parseMdx } from './mdx'
import { operationMarkdown, parseOpenApi } from './openapi'
import { mapLinkTargets, normalizeRoute, routeFromRelativePath } from './routing'
import {
  DocumentationError,
  type DocumentationAlternateLocale,
  type DocumentationConfig,
  type DocumentationDiagnostic,
  type DocumentationGraph,
  type DocumentationLocalesConfig,
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

  const { defaultSources, translationSources } = partitionSources(loaded, sourceFiles)
  const pages = defaultSources.map((sourcePath) => pageFromSource(loaded, sourcePath))
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
  const locales = loaded.config.locales
  if (locales) assertLocalePrefixesFree(pages, locales)
  const defaultByRoute = new Map(pages.map((page) => [page.route, page]))
  const navigation = loaded.config.navigation
    ? normalizeNavigation(loaded.config.navigation, defaultByRoute, loaded.config)
    : automaticNavigation(pages.filter((page) => page.kind === 'page'))
  navigation.push(...openApiGroups)
  assertNavigationCoverage(navigation, pages, loaded.config)

  const translations = locales
    ? translatePages(loaded, locales, pages, translationSources, warnings)
    : []
  if (translations.length > 0 && locales) assignAlternates(pages, translations, locales)
  const localizedNavigation = locales
    ? localizeNavigations(navigation, locales, translations)
    : undefined
  pages.push(...translations)
  const byRoute = new Map(pages.map((page) => [page.route, page]))
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
    ...(localizedNavigation ? { localizedNavigation } : {}),
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

interface TranslationContext {
  locale: DocumentationAlternateLocale
  counterpart: DocumentationPage
  translatedRoutes: ReadonlySet<string>
  /** Collected so one build reports every missing hash at once. */
  missingHashes: DocumentationDiagnostic[]
  warnings: DocumentationDiagnostic[]
}

function pageFromSource(
  loaded: LoadedDocumentationConfig,
  sourcePath: string,
  translation?: TranslationContext,
): DocumentationPage {
  const source = readFileSync(sourcePath, 'utf8')
  const relativePath = relative(loaded.sourceDir, sourcePath).split(sep).join('/')
  // A translation resolves references from its default-locale page's location,
  // so links copied verbatim keep working, then moves each route link into its
  // own locale when that page is translated.
  const resolved = rewriteLocalReferences(
    source,
    translation?.counterpart.relativePath ?? relativePath,
    loaded.sourceDir,
    sourcePath,
  )
  const rewritten = translation ? localizeRouteReferences(resolved, translation) : resolved
  const sourceFormat = extname(sourcePath).toLowerCase() === '.mdx' ? 'mdx' : 'markdown'
  const authored = sourceFormat === 'mdx'
    ? parseMdx(rewritten, sourcePath)
    : parseMarkdown(rewritten, sourcePath)
  if (translation) assertTranslationFrontmatter(authored.frontmatter, sourcePath)
  const route = translation
    ? localizedRoute(translation.locale.prefix, translation.counterpart.route)
    : authored.frontmatter.slug
      ? normalizeRoute(authored.frontmatter.slug)
      : routeFromRelativePath(relativePath)
  const title = authored.frontmatter.title
    ?? authored.headings.find((heading) => heading.depth === 1)?.text
    ?? translation?.counterpart.title
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
    hidden: translation ? translation.counterpart.hidden : parsed.frontmatter.hidden === true,
    noindex: translation
      ? translation.counterpart.noindex
      : loaded.config.seo.noindex === true || parsed.frontmatter.noindex === true,
    markdown: parsed.markdown,
    html: parsed.html,
    text: parsed.text,
    headings: parsed.headings,
    sourceFormat,
    kind: 'page',
    ...(sourceFormat === 'mdx' ? { mdxSource: normalizedSource } : {}),
    ...(translation
      ? {
          locale: translation.locale.code,
          translation: {
            sourceRoute: translation.counterpart.route,
            stale: checkSourceHash(authored.frontmatter.sourceHash, relativePath, sourcePath, translation),
          },
        }
      : {}),
  }
}

/**
 * The value a translation records in `sourceHash`: a prefix of the source
 * file's SHA-256, with line endings and a BOM normalized so checkouts agree.
 */
export function translationSourceHash(sourcePath: string): string {
  const source = readFileSync(sourcePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

/** Returns whether the translation is stale; a missing hash is collected as an error. */
function checkSourceHash(
  recorded: string | undefined,
  relativePath: string,
  sourcePath: string,
  translation: TranslationContext,
): boolean {
  const current = translationSourceHash(translation.counterpart.sourcePath)
  if (!recorded) {
    translation.missingHashes.push({
      code: 'translation_source_hash_missing',
      message: `${relativePath}: add sourceHash: "${current}" (translated from ${translation.counterpart.relativePath})`,
      file: sourcePath,
    })
    return false
  }
  if (recorded === current) return false
  translation.warnings.push({
    code: 'translation_stale',
    message: `${relativePath} was translated from an earlier ${translation.counterpart.relativePath}; ` +
      `update the translation, then set sourceHash: "${current}"`,
    file: sourcePath,
  })
  return true
}

function assertTranslationFrontmatter(
  frontmatter: ReturnType<typeof parseMarkdown>['frontmatter'],
  sourcePath: string,
): void {
  const inherited = (['slug', 'hidden', 'noindex'] as const).filter((key) => frontmatter[key] !== undefined)
  if (inherited.length === 0) return
  throw new DocumentationError(
    `Translations inherit ${inherited.join(', ')} from their default-locale page`,
    'documentation_translation_invalid',
    inherited.map((key) => ({
      code: 'translation_frontmatter_inherited',
      message: `Remove ${key} from the translation; set it on the default-locale page`,
      file: sourcePath,
    })),
  )
}

interface TranslationSource {
  locale: DocumentationAlternateLocale
  sourcePath: string
  /** Path inside the locale folder, which mirrors the default-locale tree. */
  localRelativePath: string
}

/** Files under a configured locale folder are translations; everything else is default-locale. */
function partitionSources(
  loaded: LoadedDocumentationConfig,
  sourceFiles: string[],
): { defaultSources: string[]; translationSources: TranslationSource[] } {
  const localesByPrefix = new Map(
    loaded.config.locales?.alternates.map((locale) => [locale.prefix, locale]) ?? [],
  )
  const defaultSources: string[] = []
  const translationSources: TranslationSource[] = []
  for (const sourcePath of sourceFiles) {
    const [first = '', ...rest] = relative(loaded.sourceDir, sourcePath).split(sep)
    const locale = rest.length > 0 ? localesByPrefix.get(first) : undefined
    if (locale) translationSources.push({ locale, sourcePath, localRelativePath: rest.join('/') })
    else defaultSources.push(sourcePath)
  }
  return { defaultSources, translationSources }
}

function translatePages(
  loaded: LoadedDocumentationConfig,
  locales: DocumentationLocalesConfig,
  defaultPages: DocumentationPage[],
  sources: TranslationSource[],
  warnings: DocumentationDiagnostic[],
): DocumentationPage[] {
  const byStem = new Map(
    defaultPages
      .filter((page) => page.kind === 'page')
      .map((page) => [withoutSourceExtension(page.relativePath), page]),
  )
  const paired = sources.map((source) => ({
    ...source,
    counterpart: byStem.get(withoutSourceExtension(source.localRelativePath)),
  }))
  const orphans = paired.filter((source) => !source.counterpart)
  if (orphans.length > 0) {
    throw new DocumentationError(
      `${orphans.length} translation(s) have no default-locale page at the same path`,
      'documentation_translation_invalid',
      orphans.map((source) => ({
        code: 'translation_orphan',
        message: `${source.locale.prefix}/${source.localRelativePath} needs ${source.localRelativePath}`,
        file: source.sourcePath,
      })),
    )
  }
  const translatedRoutes = new Map(locales.alternates.map((locale) => [locale.prefix, new Set<string>()]))
  for (const source of paired) translatedRoutes.get(source.locale.prefix)?.add(source.counterpart!.route)
  const missingHashes: DocumentationDiagnostic[] = []
  const pages = paired.map((source) =>
    pageFromSource(loaded, source.sourcePath, {
      locale: source.locale,
      counterpart: source.counterpart!,
      translatedRoutes: translatedRoutes.get(source.locale.prefix)!,
      missingHashes,
      warnings,
    }),
  )
  // `es/guide.md` and `es/guide.mdx` would both translate `guide`.
  assertUniqueRoutes(pages)
  if (missingHashes.length > 0) {
    throw new DocumentationError(
      `${missingHashes.length} translation(s) do not record the source they were translated from`,
      'documentation_translation_invalid',
      missingHashes,
    )
  }
  return pages
}

function withoutSourceExtension(path: string): string {
  return path.replace(/\.(?:md|mdx)$/i, '')
}

/** Give every member of a translation cluster the same ordered alternate set. */
function assignAlternates(
  defaultPages: DocumentationPage[],
  translations: DocumentationPage[],
  locales: DocumentationLocalesConfig,
): void {
  const order = new Map(locales.alternates.map((locale, index) => [locale.code, index]))
  const bySource = new Map<string, DocumentationPage[]>()
  for (const page of translations) {
    const sourceRoute = page.translation!.sourceRoute
    bySource.set(sourceRoute, [...(bySource.get(sourceRoute) ?? []), page])
  }
  for (const page of defaultPages) {
    const versions = bySource.get(page.route)
    if (!versions) continue
    versions.sort((left, right) => order.get(left.locale!)! - order.get(right.locale!)!)
    const alternates = [
      { locale: locales.default.code, route: page.route },
      ...versions.map((version) => ({ locale: version.locale!, route: version.route })),
    ]
    for (const member of [page, ...versions]) member.alternates = alternates
  }
}

/** Default-locale routes may not claim a locale prefix, whatever their slug. */
function assertLocalePrefixesFree(pages: DocumentationPage[], locales: DocumentationLocalesConfig): void {
  const prefixes = new Set(locales.alternates.map((locale) => locale.prefix))
  const collisions = pages.filter((page) => prefixes.has((page.route.split('/')[1] ?? '').toLowerCase()))
  if (collisions.length === 0) return
  throw new DocumentationError(
    `${collisions.length} default-locale page(s) use a locale route prefix`,
    'documentation_route_reserved',
    collisions.map((page) => ({
      code: 'locale_prefix_route',
      message: `${page.route} starts with a locale prefix; translations live in lowercase locale folders`,
      file: page.sourcePath,
    })),
  )
}

/**
 * Each locale's navigation is the default navigation filtered to the pages that
 * exist in that locale, so documentation.json stays the one navigation authority.
 */
function localizeNavigations(
  navigation: DocumentationNavigationNode[],
  locales: DocumentationLocalesConfig,
  translations: DocumentationPage[],
): Record<string, DocumentationNavigationNode[]> {
  const missingLabels: DocumentationDiagnostic[] = []
  const localized = Object.fromEntries(
    locales.alternates.map((locale) => {
      const bySource = new Map(
        translations
          .filter((page) => page.locale === locale.code)
          .map((page) => [page.translation!.sourceRoute, page]),
      )
      // A locale with no translations yet has no pages to show a sidebar on.
      if (bySource.size === 0) return [locale.code, []]
      const filter = (nodes: DocumentationNavigationNode[]): DocumentationNavigationNode[] =>
        nodes.flatMap((node): DocumentationNavigationNode[] => {
          if (node.kind === 'page') {
            const page = bySource.get(node.route)
            return page ? [{ kind: 'page', route: page.route, label: page.title }] : []
          }
          if (node.kind === 'group') {
            const items = filter(node.items)
            // Keep any group with something left in it, including link-only groups.
            return items.length > 0 ? [{ ...node, items }] : []
          }
          const page = node.href.startsWith('/') ? bySource.get(node.href) : undefined
          return [{ ...node, href: page?.route ?? node.href }]
        })
      const label = (value: string): string => {
        const translated = locale.navigationLabels[value]
        if (translated) return translated
        missingLabels.push({
          code: 'translation_navigation_label_missing',
          message: `locales: add navigationLabels["${value}"] for ${locale.code}`,
        })
        return value
      }
      const relabel = (nodes: DocumentationNavigationNode[]): DocumentationNavigationNode[] =>
        nodes.map((node) => {
          if (node.kind === 'page') return node
          if (node.kind === 'group') return { ...node, label: label(node.label), items: relabel(node.items) }
          return { ...node, label: label(node.label) }
        })
      return [locale.code, relabel(filter(navigation))]
    }),
  )
  if (missingLabels.length > 0) {
    throw new DocumentationError(
      `${missingLabels.length} translated navigation label(s) are missing`,
      'documentation_translation_invalid',
      missingLabels,
    )
  }
  return localized
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
  const sectionIds = new Map<DocumentationPage, Set<string>>()
  for (const page of pages) {
    if (page.kind !== 'page') continue
    const pattern = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
    const prose = page.locale ? stripCodeForValidation(page.markdown) : ''
    for (const match of page.markdown.matchAll(pattern)) {
      const isImage = match[1] === '!'
      const href = match[2]
      const line = (): number => page.markdown.slice(0, match.index).split('\n').length
      // A translation's headings get their own ids, so a section link copied
      // from the source can name a section its target no longer has. Code
      // samples stay as written, so links inside them are not checked.
      const checkSection = (target: DocumentationPage, fragment: string): void => {
        if (!page.locale || !fragment || prose[match.index] !== page.markdown[match.index]) return
        let ids = sectionIds.get(target)
        if (!ids) {
          ids = new Set([
            ...target.headings.map((heading) => heading.id),
            ...[...target.html.matchAll(/\bid="([^"]+)"/g)].map((id) => id[1]!),
          ])
          sectionIds.set(target, ids)
        }
        const id = safeDecode(fragment)
        if (ids.has(id)) return
        const sections = target.headings.map((heading) => `#${heading.id}`).join(', ') || 'none'
        diagnostics.push({
          code: 'translation_anchor_missing',
          message: `${href}: no section #${id} on ${target.route} (translated headings get their own ids). Sections: ${sections}`,
          file: page.sourcePath,
          line: line(),
        })
      }
      if (isImage || href.startsWith('/media/')) continue
      if (href.startsWith('#')) {
        checkSection(page, href.slice(1))
        continue
      }
      if (/^(?:https?:|mailto:|data:)/i.test(href)) continue
      const routePart = href.split('#')[0].split('?')[0]
      if (!routePart) continue
      // A translation's relative links left after rewriting sit in code samples;
      // check them from the default-locale page's location, as the source is.
      const target = routePart.startsWith('/')
        ? normalizeRoute(routePart)
        : normalizeRoute(posix.join(dirname(page.translation?.sourceRoute ?? page.route), routePart))
      const normalized = navigationReferenceToRoute(target)
      const targetPage = byRoute.get(normalized)
      if (targetPage) checkSection(targetPage, href.split('#')[1] ?? '')
      else if (!redirects[normalized]) {
        diagnostics.push({
          code: 'broken_internal_link',
          message: `${href} resolves to ${normalized}`,
          file: page.sourcePath,
          line: line(),
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

/**
 * Point a translation's route links, outside code samples, at the same-locale
 * page when one exists. Relative links that name no source file, such as a
 * redirect or an API reference page, first become absolute from the
 * default-locale page's route, where the reader would have resolved them.
 */
function localizeRouteReferences(
  source: string,
  { locale: { prefix }, counterpart, translatedRoutes }: TranslationContext,
): string {
  const route = (value: string, from: string): { route: string; suffix: string } | null => {
    const boundary = value.search(/[?#]/)
    const path = boundary < 0 ? value : value.slice(0, boundary)
    if (!path) return null
    try {
      return { route: normalizeRoute(posix.join(from, path)), suffix: boundary < 0 ? '' : value.slice(boundary) }
    } catch {
      return null
    }
  }
  const absolute = (value: string): string => {
    const resolved = route(value, dirname(counterpart.route))
    return resolved ? `${resolved.route}${resolved.suffix}` : value
  }
  const localize = (value: string): string => {
    const resolved = route(value, '/')
    return resolved && translatedRoutes.has(resolved.route)
      ? `${localizedRoute(prefix, resolved.route)}${resolved.suffix}`
      : value
  }
  return mapOutsideCode(source, (text) =>
    mapLinkTargets(text, (value, kind) => {
      if (value.startsWith('/')) return localize(value)
      // Relative definitions and `src` stay as written: the definition pattern
      // also matches prose such as footnotes, and `src` holds media, not routes.
      if (kind === 'definition' || kind === 'src') return value
      return localize(absolute(value))
    }))
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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
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
