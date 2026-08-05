import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import type { DocumentationRuntimeData } from '../types'
import { documentationPublicPath } from '../routing'
import { errorMessage, safeStorageGet, safeStorageSet, writeClipboardText } from './browser'
import { ChevronRightIcon } from './icons'
import { PageActions } from './page-actions'

export function Article({
  children,
  data,
  onAssistantOpen,
}: {
  children?: ReactNode
  data: DocumentationRuntimeData
  onAssistantOpen: (seed?: string) => void
}): ReactElement {
  const articleRef = useRef<HTMLElement>(null)
  useArticleEnhancements(articleRef, data, onAssistantOpen)
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
      {children ?? <div className="documentation-prose" dangerouslySetInnerHTML={{ __html: data.page.html }} />}
      {data.page.openapi?.playground && <ApiPlayground operation={data.page.openapi} />}
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

export function ContextRail({
  data,
}: {
  data: DocumentationRuntimeData
}): ReactElement {
  const headings = useMemo(
    () => data.page.headings.filter((heading) => heading.depth === 2 || heading.depth === 3),
    [data.page.headings],
  )
  const [active, setActive] = useState(headings[0]?.id ?? '')
  useEffect(() => setActive(headings[0]?.id ?? ''), [headings])
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const elements = headings.map((heading) => document.getElementById(heading.id)).filter(Boolean) as HTMLElement[]
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
      if (visible[0]?.target.id) setActive(visible[0].target.id)
    }, { rootMargin: '-88px 0px -68% 0px', threshold: [0, 1] })
    elements.forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [headings])
  return (
    <aside className="documentation-context-rail" aria-label="Page context">
      {headings.length > 0 && (
        <nav className="documentation-outline" aria-label="On this page">
          <h2>On this page</h2>
          {headings.map((heading) => (
            <a
              aria-current={active === heading.id ? 'location' : undefined}
              className={`${heading.depth === 3 ? 'depth-3 ' : ''}${active === heading.id ? 'is-active' : ''}`}
              href={`#${heading.id}`}
              key={heading.id}
            >{heading.text}</a>
          ))}
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
      <label><span>Bearer token</span><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Optional" /></label>
      <label><span>JSON body</span><textarea rows={7} spellCheck="false" value={body} onChange={(event) => setBody(event.target.value)} placeholder="{}" /></label>
      <button type="button" disabled={sending} onClick={send}>{sending ? 'Sending…' : `Send ${operation.method} request`}</button>
      <pre aria-live="polite">{responseText}</pre>
    </section>
  )
}

function useArticleEnhancements(
  articleRef: RefObject<HTMLElement | null>,
  data: DocumentationRuntimeData,
  onAssistantOpen: (seed?: string) => void,
): void {
  useEffect(() => {
    const article = articleRef.current
    if (!article) return
    const cleanups: Array<() => void> = []
    article.querySelectorAll<HTMLPreElement>('.documentation-prose pre').forEach((pre) => {
      if (pre.querySelector('.documentation-code-actions')) return
      const controls = document.createElement('div')
      controls.className = 'documentation-code-actions'
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.setAttribute('aria-label', 'Copy code')
      copy.textContent = 'Copy'
      const copyHandler = async (): Promise<void> => {
        await writeClipboardText(pre.querySelector('code')?.textContent ?? pre.textContent ?? '')
        copy.textContent = 'Copied'
        window.setTimeout(() => { copy.textContent = 'Copy' }, 1400)
      }
      copy.addEventListener('click', copyHandler)
      controls.appendChild(copy)
      if (data.config.assistant.access !== 'disabled') {
        const ask = document.createElement('button')
        ask.type = 'button'
        ask.textContent = 'Ask'
        ask.setAttribute('aria-label', 'Ask the documentation assistant about this code')
        const askHandler = (): void => {
          const code = pre.querySelector('code')?.textContent?.trim().slice(0, 1200) ?? ''
          onAssistantOpen(`Explain this ${data.page.title} example and the important details:\n\n${code}`)
        }
        ask.addEventListener('click', askHandler)
        controls.appendChild(ask)
        cleanups.push(() => ask.removeEventListener('click', askHandler))
      }
      pre.appendChild(controls)
      cleanups.push(() => { copy.removeEventListener('click', copyHandler); controls.remove() })
    })

    article.querySelectorAll<HTMLElement>('[data-tab-group]').forEach((group, groupIndex) => {
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
  }, [articleRef, data.config.assistant.access, data.page.route, data.page.title, onAssistantOpen])
}
