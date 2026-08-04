import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type {
  DocsConfig,
  DocsNavigationNode,
  DocsPage,
  DocsRuntimeData,
  DocsRuntimeRouteDocument,
} from './types'
import { DocsApp } from './runtime/app'
import { joinSiteUrl, markdownUrlForRoute } from './routing'
import { escapeHtml } from './text'
export { DOCS_CSS } from './runtime/styles'

const ASSET_ROOT = '/_docs/assets'

export interface DocsPageRenderOptions {
  config: DocsConfig
  page: DocsPage
  pages: DocsPage[]
  navigation: DocsNavigationNode[]
}

export interface DocsPageRuntime {
  data: DocsRuntimeData
  document: DocsRuntimeRouteDocument
}

export function renderPage(options: DocsPageRenderOptions, assets: {
  customStylesheets?: string[]
  markup?: string
  runtimeModule?: boolean
  runtimeScript?: string
} = {}, runtime = createPageRuntime(options)): string {
  const { config, page } = options
  const { data: runtimeData, document: runtimeDocument } = runtime
  const accent = validCssColor(config.theme.accent) ? config.theme.accent : '#635bff'
  const background = validCssColor(config.theme.background) ? config.theme.background : '#fbfcfe'
  const backgroundDark = validCssColor(config.theme.backgroundDark) ? config.theme.backgroundDark : '#0c0e14'
  const defaultMode = config.theme.defaultMode ?? 'system'
  const bodyFont = cssFontStack(config.theme.bodyFont?.family)
  const headingFont = cssFontStack(config.theme.headingFont?.family ?? config.theme.bodyFont?.family)
  const monoFont = cssMonoFontStack(config.theme.monoFont?.family)
  const fontFaces = renderFontFaces(config)
  const fontPreloads = renderFontPreloads(config)
  const markup = assets.markup ?? renderToString(createElement(DocsApp, { data: runtimeData }))

  return `<!doctype html>
<html lang="en" data-theme-mode="${defaultMode}" data-theme-strict="${config.theme.strictMode ? 'true' : 'false'}" data-code-mode="${config.theme.codeBlockMode ?? 'dark'}" data-background-decoration="${config.theme.backgroundDecoration ?? 'none'}" data-eyebrow-style="${config.theme.eyebrowStyle ?? 'section'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(runtimeDocument.title)}</title>
  <meta name="description" content="${escapeHtml(runtimeDocument.description ?? '')}">
  <meta name="generator" content="DeepSpace Docs Orbit">
  <meta name="color-scheme" content="light dark">
  ${runtimeDocument.robots ? `<meta name="robots" content="${escapeHtml(runtimeDocument.robots)}">` : ''}
  ${runtimeDocument.canonical ? `<link rel="canonical" href="${escapeHtml(runtimeDocument.canonical)}">` : ''}
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(runtimeDocument.openGraph['og:title'] ?? '')}">
  <meta property="og:description" content="${escapeHtml(runtimeDocument.openGraph['og:description'] ?? '')}">
  ${runtimeDocument.openGraph['og:url'] ? `<meta property="og:url" content="${escapeHtml(runtimeDocument.openGraph['og:url'])}">` : ''}
  ${config.seo.ogImage ? `<meta property="og:image" content="${escapeHtml(config.seo.ogImage)}">` : ''}
  ${renderCustomMeta(config.seo.metaTags)}
  ${config.theme.favicon ? `<link rel="icon" href="${escapeHtml(config.theme.favicon)}">` : ''}
  ${fontPreloads}
  <link rel="stylesheet" href="${ASSET_ROOT}/docs.css">
  ${(assets.customStylesheets ?? []).map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('\n  ')}
  <style>${fontFaces}:root{--docs-accent:${accent};--docs-brand-bg:${background};--docs-brand-bg-dark:${backgroundDark};--docs-font-body:${bodyFont};--docs-font-heading:${headingFont};--docs-font-mono:${monoFont}}</style>
  <script src="${ASSET_ROOT}/docs-theme.js"></script>
</head>
<body data-route="${escapeHtml(page.route)}">
  <div id="deepspace-docs-root">${markup}</div>
  <script id="deepspace-docs-data" type="application/json">${serializeBootstrap(runtimeData)}</script>
  <script${assets.runtimeModule ? ' type="module"' : ''} src="${escapeHtml(assets.runtimeScript ?? `${ASSET_ROOT}/docs-runtime.js`)}" defer></script>
</body>
</html>`
}

function renderFontFaces(config: DocsConfig): string {
  const fonts = [config.theme.bodyFont, config.theme.headingFont, config.theme.monoFont]
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

function renderFontPreloads(config: DocsConfig): string {
  const sources = new Set(
    [config.theme.bodyFont, config.theme.headingFont, config.theme.monoFont]
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

export function createNotFoundPage(): DocsPage {
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
  config: DocsConfig,
  navigation: DocsNavigationNode[],
  assets: Parameters<typeof renderPage>[1] = {},
): string {
  const page = createNotFoundPage()
  return renderPage({ config, page, pages: [page], navigation }, assets)
}

export function createRuntimeRouteDocument(options: {
  config: DocsConfig
  page: DocsPage
  pages: DocsPage[]
  navigation: DocsNavigationNode[]
}): DocsRuntimeRouteDocument {
  return createPageRuntime(options).document
}

export function createPageRuntime(options: DocsPageRenderOptions): DocsPageRuntime {
  const { config, page, pages, navigation } = options
  const data = createRuntimeData(config, page, pages, navigation)
  return {
    data,
    document: createRuntimeRouteDocumentFromData(config, page, data),
  }
}

function createRuntimeRouteDocumentFromData(
  config: DocsConfig,
  page: DocsPage,
  runtimeData: DocsRuntimeData,
): DocsRuntimeRouteDocument {
  const data = {
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

export function renderRedirect(to: string): string {
  const safe = escapeHtml(to)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${safe}"><link rel="canonical" href="${safe}"><title>Redirecting…</title></head><body><p>Redirecting to <a href="${safe}">${safe}</a>.</p></body></html>`
}

export function createRuntimeData(
  config: DocsConfig,
  page: DocsPage,
  pages: DocsPage[],
  navigation: DocsNavigationNode[],
): DocsRuntimeData {
  const ordered = orderedRoutes(navigation)
  const pageIndex = ordered.indexOf(page.route)
  const previous = pageIndex > 0
    ? pages.find((candidate) => candidate.route === ordered[pageIndex - 1])
    : undefined
  const next = pageIndex >= 0
    ? pages.find((candidate) => candidate.route === ordered[pageIndex + 1])
    : undefined
  return {
    config: {
      name: config.name,
      ...(config.description ? { description: config.description } : {}),
      theme: config.theme,
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
      html: page.html,
      headings: page.headings,
      kind: page.kind,
      markdownUrl: markdownUrlForRoute(page.route),
      ...(page.openapi ? { openapi: page.openapi } : {}),
    },
    navigation,
    breadcrumbs: findBreadcrumbs(navigation, page.route) ?? [config.name, page.title],
    ...(previous ? { previous: { route: previous.route, title: previous.title } } : {}),
    ...(next ? { next: { route: next.route, title: next.title } } : {}),
  }
}

function findBreadcrumbs(
  nodes: DocsNavigationNode[],
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

function orderedRoutes(nodes: DocsNavigationNode[]): string[] {
  return nodes.flatMap((node): string[] => {
    if (node.kind === 'page') return [node.route]
    if (node.kind === 'group') return orderedRoutes(node.items)
    return []
  })
}

function serializeBootstrap(data: DocsRuntimeData): string {
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
  return /^(?:\/_docs\/[a-z0-9_./%-]+|https:\/\/[^\s"'()<>]+)$/i.test(value)
}

function themeBootstrap(): void {
  try {
    const stored = localStorage.getItem('deepspace-docs-theme')
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

export const DOCS_THEME_BOOTSTRAP = `(${themeBootstrap.toString()})()\n`
