import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { hydrateRoot } from 'react-dom/client'
import type { DocsRuntimeData, DocsRuntimeRouteDocument } from '../types'
import {
  currentHistoryState,
  currentRuntimeDocument,
  focusArticleHeading,
  locationKey,
  replaceHistoryScroll,
  routeDataUrl,
  scrollToTarget,
  syncDocument,
  type RuntimeDocument,
} from './client-document'
import {
  DefaultDocs,
  DocsContent,
  type DocsPageComponent,
  type DocsSiteComponent,
} from './public'
import { shouldHandleDocsNavigation } from './routing'
export * from './public'


type HistoryMode = 'none' | 'push'

export function DocsRuntimeRoot({
  initialData,
  loadPage,
  pages = {},
  Site = DefaultDocs as DocsSiteComponent,
}: {
  initialData: DocsRuntimeData
  loadPage?: (route: string) => Promise<void>
  pages?: Record<string, DocsPageComponent>
  Site?: DocsSiteComponent
}) {
  const [data, setData] = useState(initialData)
  const [navigating, setNavigating] = useState(false)
  const cacheRef = useRef(new Map<string, RuntimeDocument>())
  const inFlightRef = useRef(new Map<string, Promise<RuntimeDocument>>())
  const siteDataRef = useRef({ config: initialData.config, navigation: initialData.navigation })
  const navigationIdRef = useRef(0)
  const restoringHistoryRef = useRef(false)
  const scrollFrameRef = useRef<number | null>(null)
  const renderedLocationRef = useRef(locationKey(new URL(window.location.href)))

  useEffect(() => {
    cacheRef.current.set(locationKey(new URL(window.location.href)), currentRuntimeDocument(initialData))
    const previous = history.scrollRestoration
    history.scrollRestoration = 'manual'
    replaceHistoryScroll(window.scrollY)
    const handleScroll = (): void => {
      if (restoringHistoryRef.current) return
      if (scrollFrameRef.current !== null) return
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null
        replaceHistoryScroll(window.scrollY)
      })
    }
    const handlePopState = (): void => {
      const restoredScroll = currentHistoryState().scrollY
      restoringHistoryRef.current = true
      void navigate(window.location.href, 'none', restoredScroll)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('popstate', handlePopState)
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
      history.scrollRestoration = previous
    }
  // The initial payload is immutable for the lifetime of this hydrated root.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(async (target: URL): Promise<RuntimeDocument> => {
    const key = locationKey(target)
    const cached = cacheRef.current.get(key)
    if (cached) return cached
    const pending = inFlightRef.current.get(key)
    if (pending) return pending
    const request = (async (): Promise<RuntimeDocument> => {
      const response = await fetch(routeDataUrl(target), {
        headers: { Accept: 'application/json', 'x-deepspace-docs-navigation': 'true' },
      })
      if (!response.ok) throw new Error(`Route data returned ${response.status}`)
      const routeDocument = await response.json() as DocsRuntimeRouteDocument
      if (!routeDocument?.data?.page || typeof routeDocument.title !== 'string') {
        throw new Error('Navigation response did not contain valid DeepSpace docs route data')
      }
      const runtime: RuntimeDocument = {
        ...routeDocument,
        data: { ...siteDataRef.current, ...routeDocument.data },
      }
      cacheRef.current.set(key, runtime)
      return runtime
    })()
    inFlightRef.current.set(key, request)
    try {
      return await request
    } finally {
      if (inFlightRef.current.get(key) === request) inFlightRef.current.delete(key)
    }
  }, [])

  const navigate = useCallback(async (
    href: string,
    historyMode: HistoryMode = 'push',
    restoredScroll?: number,
  ): Promise<void> => {
    const target = new URL(href, window.location.href)
    if (target.origin !== window.location.origin) {
      window.location.assign(target.href)
      return
    }
    const currentUrl = new URL(window.location.href)
    const targetKey = locationKey(target)
    if (targetKey === renderedLocationRef.current) {
      if (historyMode === 'push' && target.href !== currentUrl.href) {
        replaceHistoryScroll(window.scrollY)
        history.pushState({ deepspaceDocs: true, scrollY: 0 }, '', target.href)
      }
      scrollToTarget(target, historyMode === 'none' ? restoredScroll : undefined)
      restoringHistoryRef.current = false
      replaceHistoryScroll(window.scrollY)
      return
    }

    const navigationId = ++navigationIdRef.current
    const progressTimer = window.setTimeout(() => {
      if (navigationId === navigationIdRef.current) setNavigating(true)
    }, 120)
    try {
      const runtime = await load(target)
      await loadPage?.(runtime.data.page.route)
      if (navigationId !== navigationIdRef.current) return
      if (historyMode === 'push') {
        replaceHistoryScroll(window.scrollY)
        history.pushState({ deepspaceDocs: true, scrollY: 0 }, '', target.href)
      }
      syncDocument(runtime, target)
      renderedLocationRef.current = targetKey
      const startViewTransition = typeof document.startViewTransition === 'function'
        ? document.startViewTransition.bind(document)
        : undefined
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (startViewTransition && !prefersReducedMotion) {
        const transition = startViewTransition(() => {
          flushSync(() => setData(runtime.data))
        })
        await transition.updateCallbackDone
      } else {
        flushSync(() => setData(runtime.data))
      }
      scrollToTarget(target, historyMode === 'none' ? restoredScroll : undefined)
      restoringHistoryRef.current = false
      replaceHistoryScroll(window.scrollY)
      focusArticleHeading()
      if (navigationId === navigationIdRef.current) setNavigating(false)
    } catch (error) {
      if (navigationId !== navigationIdRef.current) return
      restoringHistoryRef.current = false
      console.error('[DeepSpace Docs] Client navigation failed; falling back to a document navigation', error)
      window.location.assign(target.href)
    } finally {
      window.clearTimeout(progressTimer)
    }
  }, [load, loadPage])

  const prefetch = useCallback((href: string): void => {
    const target = new URL(href, window.location.href)
    if (target.origin !== window.location.origin || cacheRef.current.has(locationKey(target))) return
    void load(target).then((runtime) => loadPage?.(runtime.data.page.route)).catch(() => {
      // Prefetch is opportunistic; an explicit navigation still retries.
    })
  }, [load, loadPage])

  useEffect(() => {
    const root = document.getElementById('deepspace-docs-root')
    if (!root) return
    const anchorFor = (target: EventTarget | null): HTMLAnchorElement | null =>
      target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
    const handleClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = anchorFor(event.target)
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return
      const href = anchor.getAttribute('href')
      if (!href || !shouldHandleDocsNavigation(href)) return
      const url = new URL(href, window.location.href)
      if (url.origin !== window.location.origin) return
      if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return
      event.preventDefault()
      void navigate(`${url.pathname}${url.search}${url.hash}`)
    }
    const handlePrefetch = (event: Event): void => {
      const href = anchorFor(event.target)?.getAttribute('href')
      if (href && shouldHandleDocsNavigation(href)) prefetch(href)
    }
    root.addEventListener('click', handleClick)
    root.addEventListener('focusin', handlePrefetch)
    root.addEventListener('mouseover', handlePrefetch)
    root.addEventListener('pointerdown', handlePrefetch)
    return () => {
      root.removeEventListener('click', handleClick)
      root.removeEventListener('focusin', handlePrefetch)
      root.removeEventListener('mouseover', handlePrefetch)
      root.removeEventListener('pointerdown', handlePrefetch)
    }
  }, [navigate, prefetch])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (data.previous) prefetch(data.previous.route)
      if (data.next) prefetch(data.next.route)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [data.next, data.page.route, data.previous, prefetch])

  const content = <DocsContent Page={pages[data.page.route]} data={data} />
  return (
    <Site
      data={data}
      navigating={navigating}
      onNavigate={(href) => { void navigate(href) }}
      onPrefetch={prefetch}
    >
      {content}
    </Site>
  )
}


let hydrated = false

export function hydrateDocs({
  loadPage,
  pages,
  Site,
}: {
  loadPage?: (route: string) => Promise<void>
  pages?: Record<string, DocsPageComponent>
  Site?: DocsSiteComponent
} = {}): void {
  const root = document.getElementById('deepspace-docs-root')
  const payload = document.getElementById('deepspace-docs-data')
  if (hydrated || !root || !payload?.textContent) return
  try {
    const initialData = JSON.parse(payload.textContent) as DocsRuntimeData
    hydrated = true
    hydrateRoot(root, <DocsRuntimeRoot initialData={initialData} loadPage={loadPage} pages={pages} Site={Site} />)
  } catch (error) {
    root.setAttribute('data-hydration-error', 'true')
    console.error('[DeepSpace Docs] Unable to hydrate the documentation surface', error)
  }
}
