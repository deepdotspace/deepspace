import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { parseSseLine } from '../../client/ai-stream'
import { documentationPublicPath } from '../routing'
import { documentationSubject } from '../text'
import { completedDocumentationAssistantTranscript } from './assistant-transcript'
import { errorMessage, externalProps, writeClipboardText } from './browser'
import { useDialogFocus } from './dialog'
import { CloseIcon, SendIcon, StopIcon } from './icons'

interface AssistantMessage {
  id: string
  role: 'assistant' | 'user'
  text: string
  state?: 'error' | 'streaming'
  status?: string
}

export interface AssistantSeed {
  id: number
  submit: boolean
  value?: string
}

export function AssistantLauncher({
  input,
  name,
  onInputChange,
  onOpen,
  onSubmit,
}: {
  input: string
  name: string
  onInputChange: (value: string) => void
  onOpen: () => void
  onSubmit: (question: string) => void
}): ReactElement {
  const subject = documentationSubject(name)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const question = input.trim()
    if (!question) return
    onSubmit(question)
  }
  return (
    <form
      className="documentation-assistant-launcher"
      id="deepspace-documentation-assistant-launcher"
      onSubmit={submit}
    >
      {/* A short, fixed label: the site name belongs in the accessible name, not
          in a chip that has to share one row with the question field. Reading it
          from `name` clipped every site whose name was longer than "Acme Docs". */}
      <button className="documentation-launcher-agent" type="button" onClick={onOpen} aria-label={`Open the ${subject} agent`}>
        Ask <span className="documentation-launcher-agent-name">AI</span>
      </button>
      <input
        aria-label={`Ask the ${subject} agent`}
        id="deepspace-documentation-assistant-launcher-input"
        maxLength={4000}
        onChange={(event) => onInputChange(event.target.value)}
        placeholder="Ask anything…"
        value={input}
      />
      <span aria-hidden="true" className="documentation-launcher-hint"><kbd>⌘</kbd><kbd>I</kbd></span>
      <button className="documentation-launcher-send" type="submit" disabled={!input.trim()} aria-label="Send question to documentation agent"><SendIcon /></button>
    </form>
  )
}

export function DocumentationAssistant({
  access,
  basePath,
  input,
  name,
  onClose,
  onInputChange,
  open,
  route,
  seed,
  suggestions,
}: {
  access: 'public' | 'authenticated'
  basePath: string
  input: string
  name: string
  onClose: () => void
  onInputChange: (value: string) => void
  open: boolean
  route: string
  seed: AssistantSeed
  suggestions?: string[]
}): ReactElement | null {
  const panelRef = useRef<HTMLElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const queuedQuestionRef = useRef<string | null>(null)
  const handledSeedRef = useRef(0)
  const [messages, setMessages] = useState<AssistantMessage[]>([
    { id: 'welcome', role: 'assistant', text: `I can search the ${documentationSubject(name)} and cite the exact pages I use.` },
  ])
  const [sending, setSending] = useState(false)
  useDialogFocus(open, panelRef, onClose, false, 'deepspace-documentation-assistant-launcher-input')
  useEffect(() => {
    if (!open || seed.id === 0 || handledSeedRef.current === seed.id) return
    handledSeedRef.current = seed.id
    if (!seed.submit || !seed.value?.trim()) return
    queuedQuestionRef.current = seed.value
    const frame = window.requestAnimationFrame(() => formRef.current?.requestSubmit())
    return () => window.cancelAnimationFrame(frame)
  }, [open, seed])
  useEffect(() => {
    const element = messagesRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [messages])
  useEffect(() => () => abortRef.current?.abort(), [])
  if (!open) return null

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const question = (queuedQuestionRef.current ?? input).trim()
    queuedQuestionRef.current = null
    if (!question || sending) return
    const transcript = completedDocumentationAssistantTranscript(messages)
    onInputChange('')
    setSending(true)
    const userId = `user-${Date.now()}`
    const answerId = `assistant-${Date.now()}`
    setMessages((current) => [...current, { id: userId, role: 'user', text: question }, { id: answerId, role: 'assistant', text: '', state: 'streaming', status: 'Searching this documentation…' }])
    const controller = new AbortController()
    abortRef.current = controller
    let timedOut = false
    const slowTimer = window.setTimeout(() => {
      setMessages((current) => current.map((message) => message.id === answerId
        ? { ...message, status: 'Still working through the documentation…' }
        : message))
    }, 12_000)
    const timeoutTimer = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 120_000)
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (access === 'authenticated') {
        const tokenResponse = await fetch('/api/auth/token', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
        const tokenData = tokenResponse.ok ? await tokenResponse.json().catch(() => null) as { token?: string } | null : null
        if (!tokenData?.token) throw new Error('Sign in to use the documentation assistant.')
        headers.Authorization = `Bearer ${tokenData.token}`
      }
      const response = await fetch(documentationPublicPath(basePath, '/api/ai'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ question, route, messages: transcript }),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error ?? `Assistant unavailable (${response.status})`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let answer = ''
      const consumeLine = (line: string): void => {
        const data = parseSseLine(line)
        if (!data) return
        if (data.type === 'text-delta' && typeof data.delta === 'string') {
          answer += data.delta
          setMessages((current) => current.map((message) => message.id === answerId ? { ...message, text: answer, state: 'streaming', status: undefined } : message))
        } else if (data.type === 'tool-input-available') {
          const status = data.toolName === 'documentation_read'
            ? 'Reading the relevant source pages…'
            : 'Searching this documentation…'
          setMessages((current) => current.map((message) => message.id === answerId ? { ...message, status } : message))
        } else if (data.type === 'tool-output-available') {
          setMessages((current) => current.map((message) => message.id === answerId ? { ...message, status: 'Reviewing the source material…' } : message))
        } else if (data.type === 'error') {
          throw new Error(typeof data.errorText === 'string' ? data.errorText : 'The assistant stream failed.')
        }
      }
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) consumeLine(line)
      }
      buffer += decoder.decode()
      consumeLine(buffer)
      setMessages((current) => current.map((message) => message.id === answerId ? { ...message, text: answer || 'No answer was returned.', state: undefined } : message))
    } catch (error) {
      const message = timedOut
        ? 'The documentation search took too long. Try a narrower question.'
        : controller.signal.aborted
          ? 'Response stopped.'
          : errorMessage(error)
      setMessages((current) => current.map((item) => item.id === answerId ? { ...item, text: message, state: 'error' } : item))
    } finally {
      window.clearTimeout(slowTimer)
      window.clearTimeout(timeoutTimer)
      abortRef.current = null
      setSending(false)
    }
  }

  const defaults = suggestions ?? ['How do I get started?', 'Show me a complete example', 'What should I understand first?']
  return (
    <aside
      aria-label="Documentation assistant"
      className="documentation-assistant"
      id="deepspace-documentation-assistant"
      ref={panelRef}
      role="complementary"
    >
      <header>
        <div><span><strong id="deepspace-documentation-assistant-title">Ask {name}</strong><small>Answers from this documentation build</small></span></div>
        <button type="button" onClick={onClose} aria-label="Close documentation assistant"><CloseIcon /></button>
      </header>
      <div className="documentation-assistant-messages" ref={messagesRef} aria-live="polite">
        {messages.map((message) => (
          <div className={`documentation-assistant-message is-${message.role}${message.state ? ` is-${message.state}` : ''}`} key={message.id}>
            <div>
              {message.role === 'assistant' ? <AssistantMarkdown value={message.text} /> : message.text}
              {message.state === 'streaming' && !message.text && (
                <span className="documentation-assistant-activity" role="status"><span aria-hidden="true" />{message.status ?? 'Working…'}</span>
              )}
            </div>
          </div>
        ))}
        {messages.length === 1 && (
          <div className="documentation-assistant-suggestions">
            <p>Try asking</p>
            {defaults.map((suggestion) => <button key={suggestion} type="button" onClick={() => onInputChange(suggestion)}>{suggestion}</button>)}
          </div>
        )}
      </div>
      <form className="documentation-assistant-composer" onSubmit={submit} ref={formRef}>
        <textarea
          aria-label="Ask a documentation question"
          data-autofocus
          maxLength={4000}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder="Ask a question about this documentation"
          rows={2}
          value={input}
        />
        {sending ? (
          <button type="button" onClick={() => abortRef.current?.abort()} aria-label="Stop response"><StopIcon /></button>
        ) : (
          <button type="submit" disabled={!input.trim()} aria-label="Send question"><SendIcon /></button>
        )}
      </form>
      <footer>Responses cite this deployment and may still contain mistakes.</footer>
    </aside>
  )
}


function AssistantMarkdown({ value }: { value: string }): ReactElement {
  const blocks: ReactNode[] = []
  const fence = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g
  let cursor = 0
  for (const match of value.matchAll(fence)) {
    const index = match.index ?? 0
    if (index > cursor) blocks.push(...renderAssistantText(value.slice(cursor, index), `text-${cursor}`))
    blocks.push(
      <AssistantCodeBlock
        code={(match[2] ?? '').replace(/\n$/, '')}
        key={`code-${index}`}
        language={(match[1] ?? '').trim().split(/\s+/, 1)[0] ?? ''}
      />,
    )
    cursor = index + match[0].length
  }
  if (cursor < value.length) blocks.push(...renderAssistantText(value.slice(cursor), `text-${cursor}`))
  return <div className="documentation-assistant-markdown">{blocks}</div>
}

function AssistantCodeBlock({ code, language }: { code: string; language: string }): ReactElement {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    await writeClipboardText(code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  return (
    <figure className="documentation-assistant-code">
      <figcaption><span>{language || 'Code'}</span><button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></figcaption>
      <pre><code>{code}</code></pre>
    </figure>
  )
}

function renderAssistantText(value: string, keyPrefix: string): ReactNode[] {
  const lines = value.split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? ''
    if (!line) { index += 1; continue }
    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      blocks.push(<strong className="documentation-assistant-heading" key={`${keyPrefix}-heading-${index}`}>{renderInlineMarkdown(heading[2])}</strong>)
      index += 1
      continue
    }
    const unordered = /^[-*]\s+/.test(line)
    const ordered = /^\d+[.)]\s+/.test(line)
    if (unordered || ordered) {
      const items: ReactNode[] = []
      while (index < lines.length) {
        const candidate = lines[index]?.trim() ?? ''
        const match = unordered ? candidate.match(/^[-*]\s+(.+)$/) : candidate.match(/^\d+[.)]\s+(.+)$/)
        if (!match) break
        items.push(<li key={`${keyPrefix}-item-${index}`}>{renderInlineMarkdown(match[1])}</li>)
        index += 1
      }
      blocks.push(unordered
        ? <ul key={`${keyPrefix}-list-${index}`}>{items}</ul>
        : <ol key={`${keyPrefix}-list-${index}`}>{items}</ol>)
      continue
    }
    const paragraph: string[] = [line]
    index += 1
    while (index < lines.length) {
      const candidate = lines[index]?.trim() ?? ''
      if (!candidate || /^(?:#{1,4}\s+|[-*]\s+|\d+[.)]\s+)/.test(candidate)) break
      paragraph.push(candidate)
      index += 1
    }
    blocks.push(<p key={`${keyPrefix}-paragraph-${index}`}>{paragraph.map((part, partIndex) => <span key={`${partIndex}:${part.slice(0, 18)}`}>{renderInlineMarkdown(part)}{partIndex < paragraph.length - 1 && ' '}</span>)}</p>)
  }
  return blocks
}

function renderInlineMarkdown(value: string): ReactNode[] {
  const pattern = /(\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g
  return value.split(pattern).filter(Boolean).map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)]+)\)$/)
    if (link) return <a key={`${index}:${part}`} href={link[2]} {...externalProps(link[2])}>{link[1]}</a>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={`${index}:${part}`}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={`${index}:${part}`}>{part.slice(2, -2)}</strong>
    return <span key={`${index}:${part}`}>{part}</span>
  })
}
