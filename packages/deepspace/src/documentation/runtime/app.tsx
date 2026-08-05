import type {
  ReactNode,
  ReactElement,
} from 'react'
import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import type { DocumentationRuntimeData } from '../types'
import { Article, ContextRail } from './article'
import { AssistantLauncher, DocumentationAssistant, type AssistantSeed } from './assistant'
import { DesktopSidebar, DocumentationHeader, MobileNavigation } from './navigation'
import { SearchCommand } from './search'

export interface DocumentationAppProps {
  data: DocumentationRuntimeData
  /** Rendered page body. Omit children to use the compiler's static HTML. */
  children?: ReactNode
  navigating?: boolean
  onNavigate?: (href: string) => void
  onPrefetch?: (href: string) => void
}

export function DocumentationApp({
  data,
  children,
  navigating = false,
  onNavigate,
}: DocumentationAppProps): ReactElement {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantDraft, setAssistantDraft] = useState('')
  const [assistantSeed, setAssistantSeed] = useState<AssistantSeed>({ id: 0, submit: false })
  const assistantAccess = data.config.assistant.access === 'disabled'
    ? null
    : data.config.assistant.access
  const assistantEnabled = assistantAccess !== null
  const appClassName = [
    'documentation-app',
    assistantEnabled ? 'has-assistant' : '',
    assistantOpen ? 'is-assistant-open' : '',
    navigating ? 'is-navigating' : '',
  ].filter(Boolean).join(' ')

  const openAssistant = useCallback((seed?: string, submit = false) => {
    if (seed !== undefined) setAssistantDraft(seed)
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
      className={appClassName}
    >
      <a className="documentation-skip-link" href="#documentation-content">Skip to main content</a>
      <DocumentationHeader
        data={data}
        onMenuOpen={() => setMobileNavOpen(true)}
        onSearchOpen={() => setSearchOpen(true)}
      />
      <div className="documentation-frame">
        <DesktopSidebar data={data} />
        <main className="documentation-main" id="documentation-content">
          <div className="documentation-reader-grid">
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
        assistantEnabled={assistantEnabled}
        basePath={data.basePath}
        name={data.config.name}
        onAssistantOpen={openAssistant}
        onClose={() => setSearchOpen(false)}
        onNavigate={onNavigate}
        open={searchOpen}
      />
      {assistantAccess && (
        <>
          <AssistantLauncher
            input={assistantDraft}
            name={data.config.name}
            onOpen={() => openAssistant()}
            onInputChange={setAssistantDraft}
            onSubmit={(question) => openAssistant(question, true)}
            open={assistantOpen}
          />
          <DocumentationAssistant
            access={assistantAccess}
            basePath={data.basePath}
            input={assistantDraft}
            name={data.config.name}
            onClose={() => setAssistantOpen(false)}
            onInputChange={setAssistantDraft}
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
