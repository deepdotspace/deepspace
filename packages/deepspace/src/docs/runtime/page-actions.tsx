import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { DocsContextualAction, DocsRuntimeData } from '../types'
import { writeClipboardText } from './browser'
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EditorIcon,
  ExternalIcon,
  FileIcon,
  MessageIcon,
  OrbitMark,
  TerminalIcon,
} from './icons'

export function PageActions({
  data,
  onAssistantOpen,
}: {
  data: DocsRuntimeData
  onAssistantOpen: (seed?: string) => void
}): ReactElement | null {
  const [copied, setCopied] = useState<DocsContextualAction | null>(null)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const actions = data.config.contextual.actions.filter((action) => {
    if ((action === 'copy' || action === 'view' || action === 'chatgpt' || action === 'claude') && data.page.route === '/404') return false
    if (action === 'assistant' && data.config.assistant.access === 'disabled') return false
    if (
      (action === 'mcp' || action === 'add-mcp' || action === 'cursor' || action === 'vscode')
      && data.config.mcp.access !== 'public'
    ) return false
    return true
  })
  const primary = actions[0]

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent): void => {
      const details = detailsRef.current
      if (details && !details.contains(event.target as Node)) details.open = false
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && detailsRef.current?.open) {
        detailsRef.current.open = false
        detailsRef.current.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  if (!primary) return null

  const markCopied = (action: DocsContextualAction): void => {
    setCopied(action)
    window.setTimeout(() => setCopied((current) => current === action ? null : current), 1600)
  }
  const copyPage = async (): Promise<void> => {
    const response = await fetch(data.page.markdownUrl)
    if (!response.ok) return
    await writeClipboardText(await response.text())
    markCopied('copy')
  }
  const copyMcp = async (): Promise<void> => {
    await writeClipboardText(new URL('/mcp', window.location.origin).toString())
    markCopied('mcp')
  }
  const copyMcpInstall = async (): Promise<void> => {
    const mcpUrl = new URL('/mcp', window.location.origin).toString()
    await writeClipboardText(`npx add-mcp ${mcpUrl}`)
    markCopied('add-mcp')
  }
  const closeMenu = (): void => {
    if (detailsRef.current) detailsRef.current.open = false
  }
  const openAiContext = (provider: 'chatgpt' | 'claude'): void => {
    const markdownUrl = new URL(data.page.markdownUrl, window.location.origin).toString()
    const prompt = `Use ${markdownUrl} as context. Explain ${data.page.title} and answer my questions about this documentation page.`
    const destination = new URL(provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new')
    destination.searchParams.set('q', prompt)
    window.open(destination.toString(), '_blank', 'noopener,noreferrer')
    closeMenu()
  }
  const openMcpEditor = (editor: 'cursor' | 'vscode'): void => {
    const mcpUrl = new URL('/mcp', window.location.origin).toString()
    const name = data.config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'docs'
    if (editor === 'cursor') {
      const config = window.btoa(JSON.stringify({ url: mcpUrl }))
      window.location.href = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(config)}`
    } else {
      const config = encodeURIComponent(JSON.stringify({ name, type: 'http', url: mcpUrl }))
      window.location.href = `vscode:mcp/install?${config}`
    }
    closeMenu()
  }
  const content = (
    icon: ReactElement,
    label: string,
    description: string,
    menuItem: boolean,
    external = false,
  ): ReactElement => menuItem ? (
    <>
      <span className="docs-contextual-action-icon">{icon}</span>
      <span className="docs-contextual-action-copy"><strong>{label}</strong><small>{description}</small></span>
      {external && <ExternalIcon className="docs-contextual-action-external" />}
    </>
  ) : <>{icon}{label}</>
  const renderAction = (action: DocsContextualAction, menuItem = false): ReactElement => {
    const role = menuItem ? 'menuitem' : undefined
    if (action === 'view') {
      return <a href={data.page.markdownUrl} key={action} onClick={closeMenu} role={role}>{content(<FileIcon />, 'View as Markdown', 'Open the raw Markdown page', menuItem)}</a>
    }
    if (action === 'assistant') {
      return <button key={action} role={role} type="button" onClick={() => { closeMenu(); onAssistantOpen(`Explain the key ideas on ${data.page.title}.`) }}>{content(<OrbitMark />, 'Ask about this page', 'Use the DeepSpace agent with page context', menuItem)}</button>
    }
    if (action === 'chatgpt' || action === 'claude') {
      const label = action === 'chatgpt' ? 'Open in ChatGPT' : 'Open in Claude'
      return <button key={action} role={role} type="button" onClick={() => openAiContext(action)}>{content(<MessageIcon />, label, 'Ask questions about this page', menuItem, true)}</button>
    }
    if (action === 'mcp') {
      const label = copied === action ? 'MCP URL copied' : 'Copy MCP server URL'
      return <button key={action} role={role} type="button" onClick={copyMcp}>{content(copied === action ? <CheckIcon /> : <CopyIcon />, label, 'Copy the same-release documentation endpoint', menuItem)}</button>
    }
    if (action === 'add-mcp') {
      const label = copied === action ? 'Install command copied' : 'Copy MCP install command'
      return <button key={action} role={role} type="button" onClick={copyMcpInstall}>{content(copied === action ? <CheckIcon /> : <TerminalIcon />, label, 'Copy npx command to install MCP server', menuItem)}</button>
    }
    if (action === 'cursor' || action === 'vscode') {
      const label = action === 'cursor' ? 'Connect to Cursor' : 'Connect to VS Code'
      return <button key={action} role={role} type="button" onClick={() => openMcpEditor(action)}>{content(<EditorIcon />, label, `Install MCP server in ${action === 'cursor' ? 'Cursor' : 'VS Code'}`, menuItem, true)}</button>
    }
    const label = copied === action ? 'Page copied' : 'Copy page'
    return <button key={action} role={role} type="button" onClick={copyPage}>{content(copied === action ? <CheckIcon /> : <CopyIcon />, label, 'Copy page as Markdown for LLMs', menuItem)}</button>
  }

  return (
    <div className="docs-contextual-actions" aria-label="Page actions">
      <div className="docs-contextual-primary" aria-live="polite">{renderAction(primary)}</div>
      {actions.length > 0 && (
        <details ref={detailsRef}>
          <summary aria-label="More page actions"><ChevronDownIcon /></summary>
          <div aria-label="More page actions" className="docs-contextual-menu" role="menu">
            {actions.map((action) => renderAction(action, true))}
          </div>
        </details>
      )}
    </div>
  )
}

