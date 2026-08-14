import type { DocumentationRuntimeData, DocumentationRuntimeRouteDocument } from '../types'
import { documentationLogicalPath, documentationPublicPath } from '../routing'

export interface RuntimeDocument extends Omit<DocumentationRuntimeRouteDocument, 'data'> {
  data: DocumentationRuntimeData
}

export interface DocumentationHistoryState {
  deepspaceDocumentation?: boolean
  scrollY?: number
  [key: string]: unknown
}

export function currentRuntimeDocument(data: DocumentationRuntimeData): RuntimeDocument {
  return {
    canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
    data,
    description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? null,
    openGraph: readOpenGraph(document),
    robots: document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content ?? null,
    title: document.title,
  }
}

export function syncDocument(runtime: RuntimeDocument, target: URL): void {
  document.title = runtime.title
  syncMeta('description', runtime.description)
  syncMeta('robots', runtime.robots)
  syncLink('canonical', runtime.canonical)
  for (const property of ['og:title', 'og:description', 'og:url'] as const) {
    syncMeta(property, runtime.openGraph[property], 'property')
  }
  document.body.dataset.route = runtime.data.page.route === '/404'
    ? target.pathname
    : runtime.data.page.route
}

function readOpenGraph(source: Document): DocumentationRuntimeRouteDocument['openGraph'] {
  return Object.fromEntries(
    ['og:title', 'og:description', 'og:url'].map((property) => [
      property,
      source.querySelector<HTMLMetaElement>(`meta[property="${property}"]`)?.content ?? null,
    ]),
  ) as DocumentationRuntimeRouteDocument['openGraph']
}

function syncMeta(name: string, content: string | null, attribute: 'name' | 'property' = 'name'): void {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${name}"]`)
  if (!content) {
    element?.remove()
    return
  }
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute(attribute, name)
    document.head.appendChild(element)
  }
  element.content = content
}

function syncLink(rel: string, href: string | null): void {
  let element = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (!href) {
    element?.remove()
    return
  }
  if (!element) {
    element = document.createElement('link')
    element.rel = rel
    document.head.appendChild(element)
  }
  element.href = href
}

export function locationKey(url: URL): string {
  return `${url.pathname}${url.search}`
}

export function routeDataUrl(url: URL, basePath: string): string {
  const logical = documentationLogicalPath(basePath, url.pathname)
  if (logical === null) throw new Error(`${url.pathname} is outside the documentation route`)
  const clean = logical.replace(/^\/+|\/+$/g, '')
  return `${documentationPublicPath(basePath, `/data/${clean || 'index'}.json`)}${url.search}`
}

export function scrollToTarget(target: URL, restoredScroll?: number): void {
  if (target.hash) {
    const id = decodeURIComponent(target.hash.slice(1))
    // Instant: this path runs only on cross-page/popstate arrivals, where the
    // page just swapped — inheriting the CSS smooth behavior glides across a
    // brand-new document. Same-page anchor clicks never reach here.
    document.getElementById(id)?.scrollIntoView({ behavior: 'instant', block: 'start' })
    return
  }
  window.scrollTo({ top: restoredScroll ?? 0, behavior: 'instant' })
}

export function currentHistoryState(): DocumentationHistoryState {
  return history.state && typeof history.state === 'object'
    ? history.state as DocumentationHistoryState
    : {}
}

export function replaceHistoryScroll(scrollY: number): void {
  history.replaceState(
    { ...currentHistoryState(), deepspaceDocumentation: true, scrollY },
    '',
    window.location.href,
  )
}

export function focusArticleHeading(): void {
  const heading = document.querySelector<HTMLElement>('.documentation-article h1')
  if (!heading) return
  heading.tabIndex = -1
  heading.focus({ preventScroll: true })
}
