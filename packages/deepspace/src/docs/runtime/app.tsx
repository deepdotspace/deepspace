import type {
  ReactNode,
  ReactElement,
} from 'react'
import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import type { DocsRuntimeData } from '../types'
import { Article, ContextRail } from './article'
import { AssistantLauncher, DocsAssistant, type AssistantSeed } from './assistant'
import { DesktopSidebar, DocsHeader, MobileNavigation } from './navigation'
import { SearchCommand } from './search'

export interface DocsAppProps {
  data: DocsRuntimeData
  /** Rendered page body. Omit children to use the compiler's static HTML. */
  children?: ReactNode
  navigating?: boolean
  onNavigate?: (href: string) => void
  onPrefetch?: (href: string) => void
}

export function DocsApp({
  data,
  children,
  navigating = false,
  onNavigate,
}: DocsAppProps): ReactElement {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantSeed, setAssistantSeed] = useState<AssistantSeed>({ id: 0, submit: false, value: '' })

  const openAssistant = useCallback((seed = '', submit = false) => {
    setAssistantSeed((current) => ({ id: current.id + 1, submit, value: seed }))
    setSearchOpen(false)
    setAssistantOpen(true)
  }, [])

  useEffect(() => {
    const handleKeydown = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
        event.preventDefault()
        if (data.config.assistant.access !== 'disabled') openAssistant()
      }
    }
    document.addEventListener('keydown', handleKeydown)
    return () => document.removeEventListener('keydown', handleKeydown)
  }, [data.config.assistant.access, openAssistant])

  useEffect(() => {
    setMobileNavOpen(false)
    setSearchOpen(false)
  }, [data.page.route])

  return (
    <div
      aria-busy={navigating || undefined}
      className={`${assistantOpen ? 'docs-app is-assistant-open' : 'docs-app'}${navigating ? ' is-navigating' : ''}`}
    >
      <a className="docs-skip-link" href="#docs-content">Skip to main content</a>
      <DocsHeader
        data={data}
        onMenuOpen={() => setMobileNavOpen(true)}
        onSearchOpen={() => setSearchOpen(true)}
      />
      <div className="docs-frame">
        <DesktopSidebar data={data} />
        <main className="docs-main" id="docs-content">
          <div className="docs-reader-grid">
            <Article data={data} onAssistantOpen={openAssistant}>{children}</Article>
            <ContextRail data={data} />
          </div>
        </main>
      </div>
      <MobileNavigation
        data={data}
        onClose={() => setMobileNavOpen(false)}
        open={mobileNavOpen}
      />
      <SearchCommand
        assistantEnabled={data.config.assistant.access !== 'disabled'}
        name={data.config.name}
        onAssistantOpen={openAssistant}
        onClose={() => setSearchOpen(false)}
        onNavigate={onNavigate}
        open={searchOpen}
      />
      {data.config.assistant.access !== 'disabled' && (
        <>
          <AssistantLauncher
            name={data.config.name}
            onOpen={() => openAssistant()}
            onSubmit={(question) => openAssistant(question, true)}
            open={assistantOpen}
          />
          <DocsAssistant
            access={data.config.assistant.access}
            name={data.config.name}
            onClose={() => setAssistantOpen(false)}
            open={assistantOpen}
            route={data.page.route}
            seed={assistantSeed}
            suggestions={data.config.assistant.suggestions}
          />
        </>
      )}
    </div>
  )
}
