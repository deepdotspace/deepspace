import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import type { DocumentationHeading, DocumentationRuntimeData } from '../types'
import { documentationPublicPath } from '../routing'
import { errorMessage, safeStorageGet, safeStorageSet } from './browser'
import { CodeBlockActions, CodeBlockControlsProvider, codeBlockLanguage } from './code-block'
import { ChevronRightIcon, ListIcon } from './icons'
import { PageActions } from './page-actions'

/**
 * Every imperative enhancement is scoped through this selector. React-rendered
 * prose (`data-prose="react"`) is off limits to DOM surgery: the reconciler is
 * its only writer.
 */
const HTML_PROSE_SCOPE = '.documentation-prose[data-prose="html"]'

export function Article({
  children,
  data,
  launcher,
  onAssistantOpen,
}: {
  children?: ReactNode
  data: DocumentationRuntimeData
  /** Docked assistant entry point, placed above the pagination so it can stick. */
  launcher?: ReactNode
  onAssistantOpen: (seed?: string) => void
}): ReactElement {
  const articleRef = useRef<HTMLElement>(null)
  const codeBlocks = useCodeBlockMounts(articleRef, data.page.route)
  useArticleEnhancements(articleRef, data)
  const controls = useMemo(() => ({
    assistantEnabled: data.config.assistant.access !== 'disabled',
    onAsk: (code: string) =>
      onAssistantOpen(`Explain this ${data.page.title} example and the important details:\n\n${code}`),
  }), [data.config.assistant.access, data.page.title, onAssistantOpen])
  return (
    <article className="documentation-article" ref={articleRef}>
      <Breadcrumbs items={data.breadcrumbs} />
      <header className="documentation-article-header">
        <div className="documentation-article-meta">
          {data.config.theme.eyebrowStyle !== 'none' && (
            <div className="documentation-eyebrow">{
              data.page.kind === 'openapi'
                ? 'API reference'
                : data.config.theme.eyebrowStyle === 'breadcrumbs'
                  ? data.breadcrumbs.join(' / ')
                  : data.breadcrumbs[0] ?? 'Documentation'
            }</div>
          )}
          <PageActions data={data} onAssistantOpen={onAssistantOpen} />
        </div>
        <h1>{data.page.title}</h1>
        {data.page.description && <p className="documentation-lede">{data.page.description}</p>}
      </header>
      <OutlineDisclosure headings={outlineHeadings(data.page.headings)} />
      <CodeBlockControlsProvider value={controls}>
        {children ?? (
          <div
            className="documentation-prose"
            data-prose="html"
            dangerouslySetInnerHTML={{ __html: data.page.html }}
          />
        )}
        {codeBlocks.map((mount) => createPortal(
          <CodeBlockActions readCode={() => readPreText(mount.pre)} />,
          mount.host,
          mount.key,
        ))}
      </CodeBlockControlsProvider>
      {data.page.openapi?.playground && <ApiPlayground operation={data.page.openapi} />}
      {launcher && (
        <div className="documentation-launcher-dock">{launcher}</div>
      )}
      <nav className="documentation-pagination" aria-label="Page navigation">
        {data.previous ? (
          <a rel="prev" href={documentationPublicPath(data.basePath, data.previous.route)}><small>Previous</small><span><ChevronRightIcon className="is-back" />{data.previous.title}</span></a>
        ) : <span />}
        {data.next ? (
          <a rel="next" href={documentationPublicPath(data.basePath, data.next.route)}><small>Next</small><span>{data.next.title}<ChevronRightIcon /></span></a>
        ) : <span />}
      </nav>
    </article>
  )
}

function Breadcrumbs({ items }: { items: string[] }): ReactElement {
  return (
    <nav className="documentation-breadcrumbs" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={`${item}:${items.slice(0, index + 1).join('/')}`}>{index > 0 && <ChevronRightIcon />}{item}</span>
      ))}
    </nav>
  )
}

function outlineHeadings(headings: DocumentationHeading[]): DocumentationHeading[] {
  return headings.filter((heading) => heading.depth === 2 || heading.depth === 3)
}

function OutlineLinks({
  active,
  headings,
}: {
  active: string
  headings: DocumentationHeading[]
}): ReactElement {
  return (
    <>
      {headings.map((heading) => (
        <a
          aria-current={active === heading.id ? 'location' : undefined}
          className={`${heading.depth === 3 ? 'depth-3 ' : ''}${active === heading.id ? 'is-active' : ''}`}
          href={`#${heading.id}`}
          key={heading.id}
        >{heading.text}</a>
      ))}
    </>
  )
}

/**
 * The outline below the rail's breakpoint. It carries no active state: the rail
 * owns the single scroll observer, and a collapsed disclosure has nothing to
 * highlight.
 */
function OutlineDisclosure({ headings }: { headings: DocumentationHeading[] }): ReactElement | null {
  if (headings.length === 0) return null
  return (
    <details className="documentation-outline-disclosure">
      <summary><ListIcon />On this page</summary>
      <nav className="documentation-outline" aria-label="On this page">
        <OutlineLinks active="" headings={headings} />
      </nav>
    </details>
  )
}

export function ContextRail({
  data,
}: {
  data: DocumentationRuntimeData
}): ReactElement {
  const headings = useMemo(() => outlineHeadings(data.page.headings), [data.page.headings])
  const [active, setActive] = useState(headings[0]?.id ?? '')
  useEffect(() => setActive(headings[0]?.id ?? ''), [headings])
  // Reading-line scroll spy: the active heading is the last one above the
  // anchor clearance line, and at the very bottom of a scrollable page it is
  // the final heading. An intersection band fails the case that matters most —
  // a short last section can never scroll high enough to enter the band, so
  // clicking its outline entry moved the page but not the highlight.
  useEffect(() => {
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      const root = document.documentElement
      // Clearance has one owner: the container's scroll-padding-top.
      const clearance = (Number.parseFloat(getComputedStyle(root).scrollPaddingTop) || 96) + 4
      const scrollable = root.scrollHeight > window.innerHeight + 4
      const atBottom = scrollable && window.innerHeight + window.scrollY >= root.scrollHeight - 2
      let next = headings[0]?.id ?? ''
      for (const heading of headings) {
        const element = document.getElementById(heading.id)
        if (!element) continue
        if (element.getBoundingClientRect().top <= clearance) next = heading.id
        else break
      }
      // Clamped tail: at the very bottom, a short section's heading can sit
      // below the reading line forever. An explicit anchor target (the hash)
      // that is visible there wins — the reader said which section they meant.
      if (atBottom) {
        const hashId = decodeURIComponent(window.location.hash.slice(1))
        if (hashId && headings.some((heading) => heading.id === hashId)) {
          const top = document.getElementById(hashId)?.getBoundingClientRect().top
          if (top !== undefined && top > clearance && top < window.innerHeight) next = hashId
        }
      }
      setActive(next)
    }
    const schedule = (): void => {
      if (frame === null) frame = window.requestAnimationFrame(measure)
    }
    // An outline click at the very bottom changes the hash without producing a
    // scroll event, and pushState fires no hashchange — re-measure after the
    // router's synchronous same-page handling has updated the hash.
    const onOutlineClick = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('.documentation-outline a')) {
        window.setTimeout(schedule, 0)
      }
    }
    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    window.addEventListener('popstate', schedule)
    window.addEventListener('hashchange', schedule)
    document.addEventListener('click', onOutlineClick)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('popstate', schedule)
      window.removeEventListener('hashchange', schedule)
      document.removeEventListener('click', onOutlineClick)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [headings])
  return (
    <aside className="documentation-context-rail" aria-label="Page context">
      {headings.length > 0 && (
        <nav className="documentation-outline" aria-label="On this page">
          <h2>On this page</h2>
          <OutlineLinks active={active} headings={headings} />
        </nav>
      )}
    </aside>
  )
}


function ApiPlayground({ operation }: { operation: NonNullable<DocumentationRuntimeData['page']['openapi']> }): ReactElement | null {
  const [body, setBody] = useState('')
  const [token, setToken] = useState('')
  const [responseText, setResponseText] = useState('No request sent.')
  const [sending, setSending] = useState(false)
  if (!operation.baseUrl) return null
  const url = `${operation.baseUrl.replace(/\/$/, '')}${operation.path}`
  const send = async (): Promise<void> => {
    setSending(true)
    setResponseText('Sending request…')
    try {
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = `Bearer ${token}`
      if (body.trim()) headers['Content-Type'] = 'application/json'
      const response = await fetch(url, {
        method: operation.method,
        headers,
        body: ['GET', 'HEAD'].includes(operation.method) ? undefined : body.trim() || undefined,
      })
      const text = await response.text()
      setResponseText(`${response.status} ${response.statusText}\n\n${text}`)
    } catch (error) {
      setResponseText(errorMessage(error))
    } finally {
      setSending(false)
    }
  }
  return (
    <section className="documentation-playground" data-playground>
      <div className="documentation-playground-title"><div><span className={`method method-${operation.method.toLowerCase()}`}>{operation.method}</span><strong>Try this operation</strong></div><code>{url}</code></div>
      <p>Requests run in your browser. Tokens stay in memory and never enter search or assistant context.</p>
      <label><span>Bearer token</span><input type="password" autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)} placeholder="Optional" /></label>
      <label><span>JSON body</span><textarea rows={7} autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck={false} value={body} onChange={(event) => setBody(event.target.value)} placeholder="{}" /></label>
      <button type="button" disabled={sending} onClick={send}>{sending ? 'Sending…' : `Send ${operation.method} request`}</button>
      <pre aria-live="polite">{responseText}</pre>
    </section>
  )
}

interface CodeBlockMount {
  key: string
  host: HTMLElement
  pre: HTMLPreElement
}

/**
 * Wraps each compiled `pre` so the copy/ask controls can overlay a non-scrolling
 * box. Inside `pre` they would scroll away with the code and force horizontal
 * padding onto every line. The controls themselves are portalled in so their
 * icons stay the same components the rest of the shell uses.
 *
 * Scoped to `[data-prose="html"]` on purpose: this pass reparents `pre`, which
 * is only ever safe on compiler-rendered markup the reconciler does not track.
 * React-rendered prose gets the identical wrapper from `CodeBlock` instead.
 */
function useCodeBlockMounts(
  articleRef: RefObject<HTMLElement | null>,
  route: string,
): CodeBlockMount[] {
  const [mounts, setMounts] = useState<CodeBlockMount[]>([])
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    const created: Array<{ block: HTMLElement; pre: HTMLPreElement }> = []
    const next: CodeBlockMount[] = []
    article.querySelectorAll<HTMLPreElement>(HTML_PROSE_SCOPE + ' pre').forEach((pre, index) => {
      const block = document.createElement('div')
      block.className = 'documentation-code-block'
      pre.replaceWith(block)
      block.appendChild(pre)
      // Inside a code group the tab already carries the fence title.
      const title = pre.getAttribute('data-code-title')
      if (title && !block.closest('[data-tab-group]')) {
        const bar = document.createElement('div')
        bar.className = 'documentation-code-title'
        bar.textContent = title
        block.insertBefore(bar, pre)
      }
      const host = document.createElement('div')
      host.className = 'documentation-code-actions'
      const language = codeBlockLanguage(pre.querySelector('code')?.className ?? '')
      if (language) {
        const label = document.createElement('span')
        label.className = 'documentation-code-language'
        label.textContent = language
        host.appendChild(label)
      }
      block.appendChild(host)
      created.push({ block, pre })
      next.push({ key: `${route}:${index}`, host, pre })
    })
    setMounts(next)
    return () => {
      setMounts([])
      for (const { block, pre } of created) block.replaceWith(pre)
    }
  }, [articleRef, route])
  return mounts
}

function readPreText(pre: HTMLPreElement): string {
  return pre.querySelector('code')?.textContent ?? pre.textContent ?? ''
}

/**
 * Enhances compiler-rendered tab groups. Like the code-block pass this is
 * confined to `[data-prose="html"]`: MDX renders `Tabs` and `CodeGroup` through
 * `TabGroup`, which owns its own tablist in React.
 */
function useArticleEnhancements(
  articleRef: RefObject<HTMLElement | null>,
  data: DocumentationRuntimeData,
): void {
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    const cleanups: Array<() => void> = []
    article.querySelectorAll<HTMLElement>(`${HTML_PROSE_SCOPE} [data-tab-group]`).forEach((group, groupIndex) => {
      if (group.querySelector(':scope > .documentation-tab-buttons')) return
      const tabs = Array.from(group.querySelectorAll<HTMLElement>(':scope > [data-tab]'))
      if (tabs.length === 0) return
      const controls = document.createElement('div')
      controls.className = 'documentation-tab-buttons'
      controls.setAttribute('role', 'tablist')
      const labels = tabs.map((tab, tabIndex) => tab.dataset.tabTitle ?? `Tab ${tabIndex + 1}`)
      const activate = (activeIndex: number, broadcast = false): void => {
        tabs.forEach((tab, index) => { tab.hidden = index !== activeIndex; tab.setAttribute('role', 'tabpanel') })
        Array.from(controls.querySelectorAll('button')).forEach((button, index) => {
          button.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false')
          button.setAttribute('tabindex', index === activeIndex ? '0' : '-1')
        })
        if (broadcast) {
          const label = labels[activeIndex]
          if (label) {
            safeStorageSet('deepspace-documentation-tab-selection', label)
            document.dispatchEvent(new CustomEvent('deepspace-documentation-tab-change', {
              detail: { label, source: group },
            }))
          }
        }
      }
      tabs.forEach((tab, tabIndex) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.id = `documentation-tab-${groupIndex}-${tabIndex}`
        button.setAttribute('role', 'tab')
        button.textContent = labels[tabIndex]
        tab.setAttribute('aria-labelledby', button.id)
        const click = (): void => activate(tabIndex, true)
        const keydown = (event: globalThis.KeyboardEvent): void => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
          activate(next)
          controls.querySelectorAll('button')[next]?.focus()
        }
        button.addEventListener('click', click)
        button.addEventListener('keydown', keydown)
        controls.appendChild(button)
        cleanups.push(() => { button.removeEventListener('click', click); button.removeEventListener('keydown', keydown) })
      })
      const title = group.querySelector(':scope > .documentation-code-group-title')
      if (title) group.insertBefore(controls, title.nextSibling)
      if (!title) group.insertBefore(controls, group.firstChild)
      const sync = (event: Event): void => {
        const detail = (event as CustomEvent<{ label?: string; source?: Element }>).detail
        if (!detail?.label || detail.source === group) return
        const matchingIndex = labels.findIndex((label) => label === detail.label)
        if (matchingIndex >= 0) activate(matchingIndex)
      }
      document.addEventListener('deepspace-documentation-tab-change', sync)
      const stored = safeStorageGet('deepspace-documentation-tab-selection')
      const initial = stored ? labels.findIndex((label) => label === stored) : -1
      activate(initial >= 0 ? initial : 0)
      cleanups.push(() => { document.removeEventListener('deepspace-documentation-tab-change', sync); controls.remove() })
    })
    return () => cleanups.reverse().forEach((cleanup) => cleanup())
  }, [articleRef, data.page.route])
}
