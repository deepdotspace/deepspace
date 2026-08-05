import type {
  DocumentationConfig,
  DocumentationNavigationNode,
  DocumentationPage,
  DocumentationRuntimeData,
  DocumentationRuntimeRouteDocument,
  DocumentationThemeConfig,
} from './types'
import { renderDefaultDocumentation } from './renderer'
import { documentationPublicPath, joinSiteUrl, markdownUrlForRoute } from './routing'
import { escapeHtml } from './text'
export { DOCUMENTATION_CSS } from './runtime/styles'

export interface DocumentationPageRenderOptions {
  config: DocumentationConfig
  basePath: string
  page: DocumentationPage
  pages: DocumentationPage[]
  navigation: DocumentationNavigationNode[]
}

export interface DocumentationPageRuntime {
  data: DocumentationRuntimeData
  document: DocumentationRuntimeRouteDocument
}

export function renderPage(options: DocumentationPageRenderOptions, assets: {
  customStylesheets?: string[]
  markup?: string
  runtimeModule?: boolean
  runtimeScript?: string
} = {}, runtime = createPageRuntime(options)): string {
  const { config, page } = options
  const { data: runtimeData, document: runtimeDocument } = runtime
  const theme = runtimeData.config.theme
  const accent = validCssColor(theme.accent) ? theme.accent : '#635bff'
  const background = validCssColor(theme.background) ? theme.background : '#fbfcfe'
  const backgroundDark = validCssColor(theme.backgroundDark) ? theme.backgroundDark : '#0c0e14'
  const defaultMode = theme.defaultMode ?? 'system'
  const bodyFont = cssFontStack(theme.bodyFont?.family)
  const headingFont = cssFontStack(theme.headingFont?.family ?? theme.bodyFont?.family)
  const monoFont = cssMonoFontStack(theme.monoFont?.family)
  const fontFaces = renderFontFaces(theme)
  const fontPreloads = renderFontPreloads(theme)
  const markup = assets.markup ?? renderDefaultDocumentation(runtimeData)
  const assetRoot = documentationPublicPath(options.basePath, '/assets')

  return `<!doctype html>
<html lang="en" data-theme-mode="${defaultMode}" data-theme-strict="${theme.strictMode ? 'true' : 'false'}" data-code-mode="${theme.codeBlockMode ?? 'dark'}" data-background-decoration="${theme.backgroundDecoration ?? 'none'}" data-eyebrow-style="${theme.eyebrowStyle ?? 'section'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(runtimeDocument.title)}</title>
  <meta name="description" content="${escapeHtml(runtimeDocument.description ?? '')}">
  <meta name="generator" content="DeepSpace Documentation Orbit">
  <meta name="color-scheme" content="light dark">
  ${runtimeDocument.robots ? `<meta name="robots" content="${escapeHtml(runtimeDocument.robots)}">` : ''}
  ${runtimeDocument.canonical ? `<link rel="canonical" href="${escapeHtml(runtimeDocument.canonical)}">` : ''}
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(runtimeDocument.openGraph['og:title'] ?? '')}">
  <meta property="og:description" content="${escapeHtml(runtimeDocument.openGraph['og:description'] ?? '')}">
  ${runtimeDocument.openGraph['og:url'] ? `<meta property="og:url" content="${escapeHtml(runtimeDocument.openGraph['og:url'])}">` : ''}
  ${config.seo.ogImage ? `<meta property="og:image" content="${escapeHtml(config.seo.ogImage)}">` : ''}
  ${renderCustomMeta(config.seo.metaTags)}
  ${theme.favicon ? `<link rel="icon" href="${escapeHtml(theme.favicon)}">` : ''}
  ${fontPreloads}
  <link rel="stylesheet" href="${assetRoot}/documentation.css">
  ${(assets.customStylesheets ?? []).map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('\n  ')}
  <style>${fontFaces}:root{--documentation-accent:${accent};--documentation-brand-bg:${background};--documentation-brand-bg-dark:${backgroundDark};--documentation-font-body:${bodyFont};--documentation-font-heading:${headingFont};--documentation-font-mono:${monoFont}}</style>
  <script src="${assetRoot}/documentation-theme.js"></script>
</head>
<body data-route="${escapeHtml(page.route)}">
  <div id="deepspace-documentation-root">${markup}</div>
  <script id="deepspace-documentation-data" type="application/json">${serializeBootstrap(runtimeData)}</script>
  <script${assets.runtimeModule ? ' type="module"' : ''} src="${escapeHtml(assets.runtimeScript ?? `${assetRoot}/documentation-runtime.js`)}" defer></script>
</body>
</html>`
}

function renderFontFaces(theme: DocumentationThemeConfig): string {
  const fonts = [theme.bodyFont, theme.headingFont, theme.monoFont]
  const seen = new Set<string>()
  return fonts.flatMap((font) => {
    if (!font?.source || !validFontSource(font.source)) return []
    const key = `${font.family}:${font.source}:${font.weight ?? 'normal'}`
    if (seen.has(key)) return []
    seen.add(key)
    const family = safeFontFamily(font.family)
    const weight = typeof font.weight === 'number' || /^(?:normal|bold|[1-9]00|[1-9]00\s+[1-9]00)$/i.test(String(font.weight))
      ? String(font.weight ?? 'normal')
      : 'normal'
    const format = font.format && /^[a-z0-9-]{2,20}$/i.test(font.format)
      ? ` format("${font.format}")`
      : ''
    return [`@font-face{font-family:"${family}";src:url("${font.source}")${format};font-weight:${weight};font-display:swap}`]
  }).join('')
}

function renderFontPreloads(theme: DocumentationThemeConfig): string {
  const sources = new Set(
    [theme.bodyFont, theme.headingFont, theme.monoFont]
      .flatMap((font) => font?.source && validFontSource(font.source) ? [font.source] : []),
  )
  return [...sources]
    .map((source) => `<link rel="preload" href="${escapeHtml(source)}" as="font" type="font/woff2" crossorigin>`)
    .join('\n  ')
}

function renderCustomMeta(metaTags: Record<string, string> | undefined): string {
  if (!metaTags) return ''
  return Object.entries(metaTags)
    .filter(([name]) => /^[a-z0-9][a-z0-9._:-]*$/i.test(name))
    .map(([name, content]) => `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}">`)
    .join('\n  ')
}

export function createNotFoundPage(): DocumentationPage {
  return {
    sourcePath: '',
    relativePath: '',
    route: '/404',
    title: 'Page not found',
    description: 'The documentation page you requested does not exist.',
    hidden: true,
    noindex: true,
    markdown: '',
    html: '<p>The page may have moved. Search this documentation or return to the documentation home.</p><p><a href="/">Go to documentation home</a></p>',
    text: 'Page not found',
    headings: [],
    sourceFormat: 'generated',
    kind: 'page',
  }
}

export function renderNotFound(
  config: DocumentationConfig,
  navigation: DocumentationNavigationNode[],
  assets: Parameters<typeof renderPage>[1] = {},
  basePath = '/docs',
): string {
  const page = createNotFoundPage()
  return renderPage({ config, basePath, page, pages: [page], navigation }, assets)
}

export function createRuntimeRouteDocument(options: {
  config: DocumentationConfig
  basePath: string
  page: DocumentationPage
  pages: DocumentationPage[]
  navigation: DocumentationNavigationNode[]
}): DocumentationRuntimeRouteDocument {
  return createPageRuntime(options).document
}

export function createPageRuntime(options: DocumentationPageRenderOptions): DocumentationPageRuntime {
  const { config, page, pages, navigation } = options
  const data = createRuntimeData(config, page, pages, navigation, options.basePath)
  return {
    data,
    document: createRuntimeRouteDocumentFromData(config, page, data),
  }
}

function createRuntimeRouteDocumentFromData(
  config: DocumentationConfig,
  page: DocumentationPage,
  runtimeData: DocumentationRuntimeData,
): DocumentationRuntimeRouteDocument {
  const data = {
    basePath: runtimeData.basePath,
    page: runtimeData.page,
    breadcrumbs: runtimeData.breadcrumbs,
    ...(runtimeData.previous ? { previous: runtimeData.previous } : {}),
    ...(runtimeData.next ? { next: runtimeData.next } : {}),
  }
  const canonical = config.url ? joinSiteUrl(config.url, page.route) : null
  const description = page.description ?? config.description ?? `${page.title} — ${config.name}`
  return {
    canonical,
    data,
    description,
    openGraph: {
      'og:title': page.title,
      'og:description': description,
      'og:url': canonical,
    },
    robots: page.noindex ? 'noindex, nofollow' : null,
    title: `${page.title} · ${config.name}`,
  }
}

export function renderRedirect(to: string, basePath = '/docs'): string {
  const safe = escapeHtml(documentationPublicPath(basePath, to))
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${safe}"><link rel="canonical" href="${safe}"><title>Redirecting…</title></head><body><p>Redirecting to <a href="${safe}">${safe}</a>.</p></body></html>`
}

function publicTheme(theme: DocumentationThemeConfig, basePath: string): DocumentationThemeConfig {
  const publicAsset = (value: string | undefined): string | undefined => {
    if (!value) return value
    const logical = value.startsWith('/_documentation/') ? value.slice('/_documentation'.length) : value
    return logical.startsWith('/media/') ? documentationPublicPath(basePath, logical) : logical
  }
  const publicFont = (font: DocumentationThemeConfig['bodyFont']): DocumentationThemeConfig['bodyFont'] =>
    font ? { ...font, source: publicAsset(font.source) } : font
  return {
    ...theme,
    logo: publicAsset(theme.logo),
    logoDark: publicAsset(theme.logoDark),
    favicon: publicAsset(theme.favicon),
    bodyFont: publicFont(theme.bodyFont),
    headingFont: publicFont(theme.headingFont),
    monoFont: publicFont(theme.monoFont),
  }
}

function publicPageHtml(html: string, basePath: string): string {
  return html.replace(
    /(\b(?:href|src)=["'])(\/(?!\/)[^"']*)(["'])/gi,
    (_match, prefix: string, value: string, suffix: string) => {
      const logical = value.startsWith('/_documentation/') ? value.slice('/_documentation'.length) : value
      const publicValue = basePath && (logical === basePath || logical.startsWith(`${basePath}/`))
        ? logical
        : documentationPublicPath(basePath, logical)
      return `${prefix}${publicValue}${suffix}`
    },
  )
}

export function createRuntimeData(
  config: DocumentationConfig,
  page: DocumentationPage,
  pages: DocumentationPage[],
  navigation: DocumentationNavigationNode[],
  basePath: string,
): DocumentationRuntimeData {
  const ordered = orderedRoutes(navigation)
  const pageIndex = ordered.indexOf(page.route)
  const previous = pageIndex > 0
    ? pages.find((candidate) => candidate.route === ordered[pageIndex - 1])
    : undefined
  const next = pageIndex >= 0
    ? pages.find((candidate) => candidate.route === ordered[pageIndex + 1])
    : undefined
  return {
    basePath,
    config: {
      name: config.name,
      ...(config.description ? { description: config.description } : {}),
      theme: publicTheme(config.theme, basePath),
      links: config.links,
      footer: config.footer,
      assistant: config.assistant,
      mcp: config.mcp,
      contextual: config.contextual,
    },
    page: {
      route: page.route,
      title: page.title,
      ...(page.description ? { description: page.description } : {}),
      html: publicPageHtml(page.html, basePath),
      headings: page.headings,
      kind: page.kind,
      markdownUrl: markdownUrlForRoute(page.route, basePath),
      ...(page.openapi ? { openapi: page.openapi } : {}),
    },
    navigation,
    breadcrumbs: findBreadcrumbs(navigation, page.route) ?? [config.name, page.title],
    ...(previous ? { previous: { route: previous.route, title: previous.title } } : {}),
    ...(next ? { next: { route: next.route, title: next.title } } : {}),
  }
}

function findBreadcrumbs(
  nodes: DocumentationNavigationNode[],
  route: string,
  parents: string[] = [],
): string[] | undefined {
  for (const node of nodes) {
    if (node.kind === 'page' && node.route === route) return [...parents, node.label]
    if (node.kind === 'group') {
      const result = findBreadcrumbs(node.items, route, [...parents, node.label])
      if (result) return result
    }
  }
  return undefined
}

function orderedRoutes(nodes: DocumentationNavigationNode[]): string[] {
  return nodes.flatMap((node): string[] => {
    if (node.kind === 'page') return [node.route]
    if (node.kind === 'group') return orderedRoutes(node.items)
    return []
  })
}

function serializeBootstrap(data: DocumentationRuntimeData): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function validCssColor(value: string | undefined): value is string {
  if (!value) return false
  return /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s]+\)|[a-z]{3,20})$/i.test(value)
}

function cssFontStack(value: string | undefined): string {
  const family = safeFontFamily(value ?? 'Inter')
  return `${family},ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`
}

function cssMonoFontStack(value: string | undefined): string {
  const family = safeFontFamily(value ?? 'Geist Mono')
  return `${family},ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace`
}

function safeFontFamily(value: string): string {
  return /^[a-z0-9 ,.'-]{1,80}$/i.test(value) ? value : 'Inter'
}

function validFontSource(value: string): boolean {
  return /^(?:\/[a-z0-9_./%-]+|https:\/\/[^\s"'()<>]+)$/i.test(value)
}

function themeBootstrap(): void {
  try {
    const stored = localStorage.getItem('deepspace-documentation-theme')
    const configured = document.documentElement.dataset.themeMode || 'system'
    const strict = document.documentElement.dataset.themeStrict === 'true'
    const mode = !strict && (stored === 'light' || stored === 'dark' || stored === 'system')
      ? stored
      : configured
    document.documentElement.dataset.themeMode = mode
    document.documentElement.dataset.theme = mode === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode
  } catch {
    document.documentElement.dataset.theme = 'light'
  }
}

export const DOCUMENTATION_THEME_BOOTSTRAP = `(${themeBootstrap.toString()})()\n`
