import type {
  DocumentationConfig,
  DocumentationNavigationNode,
  DocumentationPage,
  DocumentationRuntimeData,
  DocumentationRuntimeRouteDocument,
  DocumentationThemeConfig,
} from './types'
import {
  DOCUMENTATION_BUNDLED_BODY_FONT,
  DOCUMENTATION_BUNDLED_MONO_FONT,
  resolveDocumentationFonts,
  safeFontFamily,
  type DocumentationResolvedFont,
} from './fonts'
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
  const accent = documentationAccent(theme)
  const background = validCssColor(theme.background) ? theme.background : '#fbfcfe'
  const backgroundDark = validCssColor(theme.backgroundDark) ? theme.backgroundDark : '#0c0e14'
  const defaultMode = theme.defaultMode ?? 'system'
  const bodyFont = cssFontStack(theme.bodyFont?.family)
  const headingFont = cssFontStack(theme.headingFont?.family ?? theme.bodyFont?.family)
  const monoFont = cssMonoFontStack(theme.monoFont?.family)
  const fonts = resolveDocumentationFonts(theme, options.basePath)
  const fontFaces = renderFontFaces(fonts)
  const fontPreloads = renderFontPreloads(fonts)
  const markup = assets.markup ?? renderDefaultDocumentation(runtimeData)
  const assetRoot = documentationPublicPath(options.basePath, '/assets')
  const favicon = theme.favicon ?? documentationPublicPath(options.basePath, '/assets/favicon.svg')

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
  <meta name="twitter:card" content="${config.seo.ogImage ? 'summary_large_image' : 'summary'}">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="${background}">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${backgroundDark}">
  ${renderCustomMeta(config.seo.metaTags)}
  <link rel="icon" href="${escapeHtml(favicon)}">
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

function renderFontFaces(fonts: DocumentationResolvedFont[]): string {
  return fonts
    .map((font) => {
      const format = font.format ? ` format("${font.format}")` : ''
      return `@font-face{font-family:"${font.family}";src:url("${font.source}")${format};font-weight:${font.weight};font-display:swap}`
    })
    .join('')
}

function renderFontPreloads(fonts: DocumentationResolvedFont[]): string {
  return fonts
    .map((font) => `<link rel="preload" href="${escapeHtml(font.source)}" as="font" type="font/woff2" crossorigin>`)
    .join('\n  ')
}

export function documentationAccent(theme: DocumentationThemeConfig): string {
  return validCssColor(theme.accent) ? theme.accent : '#635bff'
}

/**
 * Default mark, themed from the configured accent so a site that sets no favicon
 * still gets a tab icon that matches its own palette.
 */
export function renderDocumentationFavicon(theme: DocumentationThemeConfig): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 2.5c.5 7.7 5.8 13 13.5 13.5-7.7.5-13 5.8-13.5 13.5C15.5 21.8 10.2 16.5 2.5 16 10.2 15.5 15.5 10.2 16 2.5Z" fill="${escapeHtml(documentationAccent(theme))}"/></svg>\n`
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
  const family = safeFontFamily(value, DOCUMENTATION_BUNDLED_BODY_FONT.family)
  return `${family},ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`
}

function cssMonoFontStack(value: string | undefined): string {
  const family = safeFontFamily(value, DOCUMENTATION_BUNDLED_MONO_FONT.family)
  return `${family},ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace`
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
