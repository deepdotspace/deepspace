import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { safeStorageGet, safeStorageSet, writeClipboardText } from './browser'
import { CheckIcon, CopyIcon, SparkIcon } from './icons'

export interface CodeBlockControls {
  assistantEnabled: boolean
  onAsk: (code: string) => void
}

/**
 * The article supplies the assistant wiring so code-block controls render the
 * same way whether React owns the prose (MDX) or the controls are portalled
 * into compiler HTML. Portals inherit context from their React position, so a
 * single provider in `Article` covers both.
 */
const CodeBlockContext = createContext<CodeBlockControls>({
  assistantEnabled: false,
  onAsk: () => {},
})

export const CodeBlockControlsProvider = CodeBlockContext.Provider

/** Copy and ask controls. `readCode` is evaluated at click time so the same
 * component serves a React-rendered `pre` and a compiler-rendered one. */
export function CodeBlockActions({ readCode }: { readCode: () => string }): ReactElement {
  const { assistantEnabled, onAsk } = useContext(CodeBlockContext)
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    await writeClipboardText(readCode())
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  return (
    <>
      <button aria-label={copied ? 'Code copied' : 'Copy code'} onClick={() => { void copy() }} type="button">
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {assistantEnabled && (
        <button
          aria-label="Ask the documentation assistant about this code"
          onClick={() => onAsk(readCode().trim().slice(0, 1200))}
          type="button"
        ><SparkIcon /></button>
      )}
    </>
  )
}

export function codeBlockLanguage(className: string): string {
  return /(?:^|\s)(?:language|lang)-([a-z0-9+#-]{1,20})/i.exec(className)?.[1] ?? ''
}

function childCodeClassName(children: ReactNode): string {
  const code = children as { props?: { className?: unknown } } | null
  return typeof code?.props?.className === 'string' ? code.props.className : ''
}

/**
 * The MDX `pre` replacement. The wrapper, language label, and controls are all
 * React children of the same element, so the reconciler is the only writer of
 * this subtree — the compiled-HTML path gets the identical structure from
 * `useCodeBlockMounts` instead.
 */
export function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>): ReactElement {
  const preRef = useRef<HTMLPreElement>(null)
  const language = codeBlockLanguage(childCodeClassName(children))
  const readCode = (): string =>
    preRef.current?.querySelector('code')?.textContent ?? preRef.current?.textContent ?? ''
  return (
    <div className="documentation-code-block">
      <pre {...props} ref={preRef}>{children}</pre>
      {language ? <span className="documentation-code-language">{language}</span> : null}
      <div className="documentation-code-actions"><CodeBlockActions readCode={readCode} /></div>
    </div>
  )
}

const TAB_SELECTION_KEY = 'deepspace-documentation-tab-selection'
const TAB_CHANGE_EVENT = 'deepspace-documentation-tab-change'

export interface TabGroupPanel {
  label: string
  content: ReactNode
}

/**
 * Tab groups rendered by React rather than enhanced imperatively after the
 * fact. Selection still syncs across every group on the page through the same
 * storage key and document event the compiled-HTML path uses, so a `Tabs` block
 * and a compiled tab group stay in step.
 */
export function TabGroup({
  className,
  panels,
  title,
}: {
  className: string
  panels: TabGroupPanel[]
  title?: ReactNode
}): ReactElement {
  const groupId = useId()
  const [active, setActive] = useState(0)
  const controlsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stored = safeStorageGet(TAB_SELECTION_KEY)
    const index = stored ? panels.findIndex((panel) => panel.label === stored) : -1
    if (index >= 0) setActive(index)
  }, [panels])

  useEffect(() => {
    const sync = (event: Event): void => {
      const detail = (event as CustomEvent<{ label?: string; source?: unknown }>).detail
      if (!detail?.label || detail.source === groupId) return
      const index = panels.findIndex((panel) => panel.label === detail.label)
      if (index >= 0) setActive(index)
    }
    document.addEventListener(TAB_CHANGE_EVENT, sync)
    return () => document.removeEventListener(TAB_CHANGE_EVENT, sync)
  }, [groupId, panels])

  const select = (index: number, broadcast: boolean): void => {
    setActive(index)
    const label = panels[index]?.label
    if (!broadcast || !label) return
    safeStorageSet(TAB_SELECTION_KEY, label)
    document.dispatchEvent(new CustomEvent(TAB_CHANGE_EVENT, { detail: { label, source: groupId } }))
  }

  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? panels.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + panels.length) % panels.length
    select(next, true)
    controlsRef.current?.querySelectorAll('button')[next]?.focus()
  }

  return (
    <div className={className} data-tab-group>
      {title}
      <div className="documentation-tab-buttons" ref={controlsRef} role="tablist">
        {panels.map((panel, index) => (
          <button
            aria-selected={index === active}
            id={`documentation-tab-${groupId}-${index}`}
            key={panel.label}
            onClick={() => select(index, true)}
            onKeyDown={(event) => onKeyDown(event, index)}
            role="tab"
            tabIndex={index === active ? 0 : -1}
            type="button"
          >{panel.label}</button>
        ))}
      </div>
      {panels.map((panel, index) => (
        <section
          aria-labelledby={`documentation-tab-${groupId}-${index}`}
          className="documentation-tab"
          data-tab
          data-tab-title={panel.label}
          hidden={index !== active}
          key={panel.label}
          role="tabpanel"
        >{panel.content}</section>
      ))}
    </div>
  )
}
