/**
 * ChatPanel — DO-backed AI chat surface.
 *
 * Reads canonical messages via `useQuery('ai-messages')` and sends new turns
 * through `POST /api/ai/chat`. The panel itself owns no chat lifecycle —
 * pass `chatId={null}` and we'll auto-create on first send via `onChatCreated`.
 */

import {
  useState,
  useRef,
  useEffect,
  useMemo,
  useCallback,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Square,
} from 'lucide-react'
// Atom One Dark — always-dark code blocks, reads cleanly under both
// light and dark host themes (matches the conventional chat-app pattern).
import 'highlight.js/styles/atom-one-dark.css'
import {
  getAuthToken,
  useQuery,
  parseSseLine,
  decodeAiStreamChunk,
  type AiStreamAction,
} from 'deepspace'

type ModelOption = { id: string; label: string; provider: string }

// The ai-messages columns. useQuery wraps this in a RecordData envelope
// (recordId / data / createdAt / updatedAt) — we flatten before rendering.
type AiMessageData = {
  chatId: string
  userId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  parts?: unknown[]
}

type RenderMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  parts?: unknown[]
}

type InFlightMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  parts: MessagePart[]
  /** Server-assigned recordId for the row that will be persisted at
   *  onFinish — set on assistant messages once the response header
   *  `X-Asst-Id` arrives. Dedup against the WebSocket-broadcast persisted
   *  row checks this id (which matches), avoiding the clock-skew bug that
   *  bit the previous `spawnTime` vs `createdAt` comparison. Undefined for
   *  user rows (whose `id` already matches the server-side recordId). */
  serverId?: string
  /** The chat this overlay belongs to. Items from a previous chat must
   *  not render in the current view. */
  forChatId: string
}

export interface ChatPanelProps {
  /** Active chat. `null` triggers auto-create on first send. */
  chatId: string | null
  /** Current user id; scopes the messages query as defense-in-depth. */
  userId: string
  /** Fired when the panel auto-creates a chat. */
  onChatCreated?: (chatId: string) => void
  /** Models to show in the picker. Defaults to the SDK's default set. */
  models?: ModelOption[]
  /** Clickable prompts shown when the conversation is empty. */
  emptyStatePrompts?: string[]
  /** Applied to the outer container. Use to control size, border, background. */
  className?: string
  /** Optional header slot (title, close button, etc.). Rendered above messages. */
  header?: ReactNode
  /** Tighter paddings and type for narrow containers (<400px). */
  compact?: boolean
  /** Suspend send while the parent has a chat-create in flight. Without
   *  this, a fast typist can submit between the parent's eager-create POST
   *  and its response — both layers would auto-create, spawning two chats. */
  disabled?: boolean
}

const MODEL_STORAGE_KEY = 'deepspace-ai-model'

const DEFAULT_PROMPTS = [
  'What can you help with?',
  'Summarize recent activity',
  'List my collections',
]

// Mirrors the allowlist in the scaffolded worker.ts. Sonnet 4.6 is the
// default — balanced cost/capability with the same 1M-token context as
// Opus 4.7 at ~3x lower price. Within each provider we list flagship → cheap
// so the picker shows the most capable option first when a user opens it.
// Override by passing your own `models` prop.
const DEFAULT_MODELS: ModelOption[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Anthropic' },
  { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7',   provider: 'Anthropic' },
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  provider: 'Anthropic' },
  { id: 'gpt-5.4',           label: 'GPT-5.4',           provider: 'OpenAI' },
  { id: 'gpt-5.4-mini',      label: 'GPT-5.4 mini',      provider: 'OpenAI' },
  { id: 'gpt-5.4-nano',      label: 'GPT-5.4 nano',      provider: 'OpenAI' },
  { id: 'gpt-oss-120b',      label: 'GPT-OSS 120B',      provider: 'Cerebras' },
]

// ============================================================================
// useStreamingChat — POSTs /api/ai/chat, parses Vercel data-stream lines,
// exposes an in-flight overlay until useQuery delivers the persisted rows.
// ============================================================================

function useStreamingChat(
  chatId: string | null,
  modelId: string | undefined,
  onChatCreated?: (id: string) => void,
) {
  const [inFlight, setInFlight] = useState<InFlightMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  // Mirror of `isLoading` for use inside `send`'s in-flight guard. Reading
  // from state directly would force `isLoading` into the useCallback deps,
  // recreating `send` on every loading flip and exposing a stale-closure
  // window where a programmatic retry could see the pre-flip closure.
  const isLoadingRef = useRef(false)
  const [error, setError] = useState<Error | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const lastSendRef = useRef<{ content: string } | null>(null)
  const prevChatIdRef = useRef<string | null>(chatId)

  // Abort on any transition AWAY from a real chatId — chat switch (id→id) and
  // chat clear (id→null, e.g. the active chat being deleted). null→newId is
  // the auto-create promotion mid-send and must NOT abort, or the user's
  // first message dies before it reaches the server. Without aborting on
  // id→null, deleting the chat you're streaming in lets onFinish persist an
  // orphan assistant row tagged with a chatId that no longer exists.
  useEffect(() => {
    const prev = prevChatIdRef.current
    prevChatIdRef.current = chatId
    if (prev !== null && prev !== chatId) {
      abortRef.current?.abort()
      setInFlight([])
    }
  }, [chatId])

  // Abort any in-flight stream on unmount — without this, navigating away
  // mid-stream leaks the fetch (response body keeps being consumed, setState
  // fires on an unmounted component, AI tokens keep accruing server-side).
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const send = useCallback(
    async (content: string) => {
      // Defense-in-depth guard for programmatic call paths (retry, etc.) —
      // the canSend UI gate already blocks form submits while loading. We
      // read from a ref (not state) so this callback stays stable across
      // loading transitions; that closes the stale-closure window a retry
      // click could otherwise hit during the brief moment between
      // setIsLoading(true) and React re-rendering with the new closure.
      if (isLoadingRef.current) return
      setError(null)
      lastSendRef.current = { content }

      let activeChatId = chatId
      if (!activeChatId) {
        try {
          const token = await getAuthToken()
          const res = await fetch('/api/ai/chats', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({}),
          })
          if (!res.ok) throw new Error(`Failed to create chat: ${res.status}`)
          const data = (await res.json()) as { chat: { id: string } }
          activeChatId = data.chat.id
          onChatCreated?.(activeChatId)
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)))
          return
        }
      }

      const localTs = Date.now()
      const userMessageId = `usr-${localTs}-${Math.random().toString(36).slice(2, 8)}`
      const assistantId = `asst-pending-${localTs}`
      // forChatId uses the resolved id (whether passed in or just created above).
      const userMsg: InFlightMessage = { id: userMessageId, role: 'user', content, parts: [], forChatId: activeChatId }
      const asstMsg: InFlightMessage = { id: assistantId, role: 'assistant', content: '', parts: [], forChatId: activeChatId }
      setInFlight([userMsg, asstMsg])
      isLoadingRef.current = true
      setIsLoading(true)
      abortRef.current = new AbortController()

      try {
        const token = await getAuthToken()
        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ chatId: activeChatId, userMessageId, content, modelId }),
          signal: abortRef.current.signal,
        })
        if (!res.ok || !res.body) {
          const detail = res.body ? await res.text().catch(() => '') : ''
          throw new Error(detail || `Request failed: ${res.status}`)
        }

        // Tag the in-flight assistant row with the server-assigned id so the
        // dedup memo can drop it once the persisted row arrives over WS,
        // independent of either party's clock.
        const serverAsstId = res.headers.get('X-Asst-Id')
        if (serverAsstId) {
          setInFlight((cur) =>
            cur.map((m) => (m.id === assistantId ? { ...m, serverId: serverAsstId } : m)),
          )
        }

        // v5's `toUIMessageStreamResponse` emits SSE: `data: <json>\n\n`
        // events terminating with `data: [DONE]\n\n`. `parseSseLine` +
        // `decodeAiStreamChunk` are the SDK's pure decoders (covered by
        // `ai-stream.test.ts`); we just apply the resulting actions to
        // local React state.
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) handleSseLine(line, assistantId, setInFlight, setError)
        }
        // Flush any pending bytes the streaming decoder held back at a
        // multi-byte boundary, then process the trailing line.
        buf += decoder.decode()
        handleSseLine(buf, assistantId, setInFlight, setError)
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        if (e.name !== 'AbortError') {
          console.error('[chat] STREAM error', { name: e.name, message: e.message })
          setError(e)
        }
      } finally {
        isLoadingRef.current = false
        setIsLoading(false)
        abortRef.current = null
        // No wall-clock timer to clear inFlight. Dedup is by id: user rows
        // share their id with the server; assistant rows are matched via
        // the server-emitted `X-Asst-Id` header captured into `serverId`.
      }
    },
    [chatId, modelId, onChatCreated],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const retry = useCallback(() => {
    if (lastSendRef.current) void send(lastSendRef.current.content)
  }, [send])

  return { send, stop, retry, isLoading, error, inFlight }
}

// SDK-decoded chunk → React state mutation. The decoder vocabulary
// (`AiStreamAction`) lives in `deepspace/src/client/ai-stream.ts` and is
// covered by unit tests. This function does the React-bound part: which
// in-flight message to update, how to coalesce text, when to drop the
// overlay. Keep it dumb — anything the decoder can decide should stay
// in the decoder so it remains testable in isolation.
function handleSseLine(
  line: string,
  assistantId: string,
  setInFlight: React.Dispatch<React.SetStateAction<InFlightMessage[]>>,
  setError: (e: Error | null) => void,
) {
  const chunk = parseSseLine(line)
  if (!chunk) return
  const action = decodeAiStreamChunk(chunk)
  if (!action) return
  applyStreamAction(action, assistantId, setInFlight, setError)
}

function applyStreamAction(
  action: AiStreamAction,
  assistantId: string,
  setInFlight: React.Dispatch<React.SetStateAction<InFlightMessage[]>>,
  setError: (e: Error | null) => void,
) {
  switch (action.type) {
    case 'append-text':
      // Append to the last text part if it's still the tail; otherwise start
      // a new text part. Keeps text + tool-invocations in chronological order.
      setInFlight((cur) =>
        cur.map((m) => {
          if (m.id !== assistantId) return m
          const last = m.parts[m.parts.length - 1]
          if (last && last.type === 'text') {
            const merged: MessagePart = { type: 'text', text: (last as { text: string }).text + action.delta }
            return { ...m, content: m.content + action.delta, parts: [...m.parts.slice(0, -1), merged] }
          }
          return {
            ...m,
            content: m.content + action.delta,
            parts: [...m.parts, { type: 'text', text: action.delta }],
          }
        }),
      )
      return

    case 'upsert-tool-call':
      upsertToolInvocation(setInFlight, assistantId, action.toolCallId, {
        toolName: action.toolName,
        state: 'call',
        args: action.input,
      })
      return

    case 'finalize-tool-call':
      finalizeToolInvocation(setInFlight, assistantId, action.toolCallId, {
        result: action.result as ToolInvocation['result'],
      })
      return

    case 'fail-tool-input':
      // Schema validation failed BEFORE the tool ran; no preceding
      // `tool-input-available` was emitted. Upsert a failed invocation
      // (we have toolName + the rejected input) so the user sees a tool
      // row with the failure dot, not a stuck spinner / nothing at all.
      console.error('[chat] STREAM tool-input-error', {
        toolCallId: action.toolCallId,
        errorText: action.errorText,
      })
      upsertToolInvocation(setInFlight, assistantId, action.toolCallId, {
        toolName: action.toolName,
        state: 'result',
        args: action.input,
        result: { success: false, error: action.errorText } as ToolInvocation['result'],
      })
      return

    case 'fail-tool-output':
      // Tool ran (or failed during execution); a preceding `upsert-tool-call`
      // already produced the in-flight invocation, so we just finalize it.
      console.error('[chat] STREAM tool-output-error', {
        toolCallId: action.toolCallId,
        errorText: action.errorText,
      })
      finalizeToolInvocation(setInFlight, assistantId, action.toolCallId, {
        result: { success: false, error: action.errorText } as ToolInvocation['result'],
      })
      return

    case 'stream-error':
      console.error('[chat] STREAM error', action.errorText)
      setError(new Error(action.errorText))
      // Drop the assistant overlay entirely — emptying it would leave a
      // zero-content flex container that still eats the parent's gap, showing
      // a phantom vertical space between the user message and the error banner.
      setInFlight((cur) => cur.filter((m) => m.id !== assistantId))
      return

    case 'abort':
      // Server-side abort with no error chunk to follow. Drop the empty
      // assistant overlay so we don't leave a phantom bubble — but keep
      // it if the user already saw partial text OR a tool invocation
      // landed before the abort. `parts.length > 0` covers both: a
      // text-delta appends to both `content` and `parts`, and a tool
      // call lands in `parts` only.
      setInFlight((cur) => cur.filter((m) => m.id !== assistantId || m.parts.length > 0))
      return

    default: {
      // Exhaustiveness check — adding a new variant to AiStreamAction
      // without a case here will fail this assignment at compile time.
      const _exhaustive: never = action
      void _exhaustive
      return
    }
  }
}

function upsertToolInvocation(
  setInFlight: React.Dispatch<React.SetStateAction<InFlightMessage[]>>,
  assistantId: string,
  toolCallId: string,
  inv: ToolInvocation,
) {
  const part: MessagePart = { type: 'tool-invocation', toolInvocation: inv, toolCallId }
  // Dedup by toolCallId — replace if already present (the multi-step loop
  // can re-emit a tool-input-available for the same call on retry).
  setInFlight((cur) =>
    cur.map((m) => {
      if (m.id !== assistantId) return m
      const existingIdx = m.parts.findIndex(
        (p) => p.type === 'tool-invocation' && (p as ToolInvocationPart).toolCallId === toolCallId,
      )
      if (existingIdx >= 0) {
        const next = m.parts.slice()
        next[existingIdx] = part
        return { ...m, parts: next }
      }
      return { ...m, parts: [...m.parts, part] }
    }),
  )
}

function finalizeToolInvocation(
  setInFlight: React.Dispatch<React.SetStateAction<InFlightMessage[]>>,
  assistantId: string,
  toolCallId: string,
  patch: { result: ToolInvocation['result'] },
) {
  setInFlight((cur) =>
    cur.map((m) => {
      if (m.id !== assistantId) return m
      const parts = m.parts.map((p) => {
        if (
          p.type === 'tool-invocation' &&
          (p as ToolInvocationPart).toolCallId === toolCallId
        ) {
          const inv = (p as ToolInvocationPart).toolInvocation
          const updated: ToolInvocation = { ...inv, state: 'result', result: patch.result }
          return { ...p, toolInvocation: updated }
        }
        return p
      })
      return { ...m, parts }
    }),
  )
}

// ============================================================================
// ChatPanel
// ============================================================================

export function ChatPanel({
  chatId,
  userId,
  onChatCreated,
  models: modelsProp,
  emptyStatePrompts,
  className,
  header,
  compact = false,
  disabled = false,
}: ChatPanelProps) {
  const models = modelsProp ?? DEFAULT_MODELS
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [modelId, setModelId] = useState<string | undefined>(() => {
    let saved: string | null = null
    try { saved = typeof window === 'undefined' ? null : window.localStorage.getItem(MODEL_STORAGE_KEY) } catch { saved = null }
    if (saved && models.some((m) => m.id === saved)) return saved
    return models[0]?.id
  })
  function updateModelId(id: string) {
    setModelId(id)
    try { if (typeof window !== 'undefined') window.localStorage.setItem(MODEL_STORAGE_KEY, id) } catch { /* ignore */ }
  }

  const groupedModels = useMemo(() => groupModelsByProvider(models), [models])
  const selectedModel = models.find((m) => m.id === modelId)

  const { send, stop, retry, isLoading, error, inFlight } = useStreamingChat(
    chatId,
    modelId,
    onChatCreated,
  )

  // Sentinel where-clause yields an empty result when no chat is selected.
  const queryWhere = useMemo(
    () => ({ chatId: chatId ?? '__none__', userId }),
    [chatId, userId],
  )
  const { records: persistedRecords } = useQuery<AiMessageData>('ai-messages', {
    where: queryWhere,
    orderBy: 'createdAt',
    orderDir: 'asc',
  })

  const messages: RenderMessage[] = useMemo(() => {
    const persisted: RenderMessage[] = persistedRecords.map((r) => ({
      id: r.recordId,
      role: r.data.role,
      content: r.data.content ?? '',
      parts: r.data.parts,
    }))
    const persistedIds = new Set(persisted.map((m) => m.id))

    const tail = inFlight.filter((m) => {
      // Only render in-flight items that belong to the chat we're currently
      // viewing. Prevents the previous chat's bubbles from leaking through
      // when activeChatId switches (new chat, chat select).
      if (m.forChatId !== chatId) return false
      // User rows: id is the same client/server. Assistant rows: serverId is
      // the worker-assigned recordId (from the X-Asst-Id response header) and
      // matches the WS-broadcast persisted row. Dedup is purely id-based
      // — there is no clock comparison, so client/server clock skew can't
      // leave a duplicate stuck on screen.
      if (persistedIds.has(m.id)) return false
      if (m.serverId && persistedIds.has(m.serverId)) return false
      return true
    })
    return [...persisted, ...tail]
  }, [persistedRecords, inFlight, chatId])

  const [input, setInput] = useState('')

  // Auto-scroll only when the user is already pinned to the bottom.
  const stickToBottomRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = gap < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages])

  // Auto-grow textarea, capped at 200px.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (!input) {
      el.style.height = ''
      return
    }
    const raf = requestAnimationFrame(() => {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    })
    return () => cancelAnimationFrame(raf)
  }, [input])

  const canSend = input.trim().length > 0 && !isLoading && !disabled

  function submit() {
    if (!canSend) return
    const value = input.trim()
    setInput('')
    void send(value)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function onPickPrompt(prompt: string) {
    setInput(prompt)
    inputRef.current?.focus()
  }

  const prompts = emptyStatePrompts ?? DEFAULT_PROMPTS
  const lastMessage = messages[messages.length - 1]
  const streamingAssistantId =
    isLoading && lastMessage?.role === 'assistant' ? lastMessage.id : null
  const waitingForAssistant = isLoading && lastMessage?.role === 'user'

  const outerPx = compact ? 'px-4' : 'px-6'
  const textSize = compact ? 'text-[13px]' : 'text-[14px]'
  const turnGap = compact ? 'gap-6' : 'gap-8'

  return (
    <div
      className={`relative flex h-full min-h-0 flex-col bg-background text-foreground ${textSize} ${className ?? ''}`}
    >
      {header && <div className="shrink-0">{header}</div>}

      {/* min-h-0 is required on a flex-1 child so overflow-y-auto actually
          activates instead of growing the parent. */}
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-label="Assistant conversation"
        className={`min-h-0 flex-1 overflow-y-auto ${outerPx} py-8`}
      >
        {messages.length === 0 ? (
          <EmptyState prompts={prompts} onPick={onPickPrompt} />
        ) : (
          <div className={`mx-auto flex max-w-[44rem] flex-col ${turnGap}`}>
            {messages.map((m) => (
              <MessageTurn
                key={m.id}
                role={m.role}
                content={m.content}
                parts={m.parts as unknown[] | undefined}
                isStreaming={m.id === streamingAssistantId}
              />
            ))}
            {waitingForAssistant && <ThinkingIndicator />}
          </div>
        )}
      </div>

      {error && (
        <div className={`mx-auto mb-2 w-full max-w-[44rem] ${outerPx}`} role="alert">
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="flex-1 text-[13px] leading-relaxed">{error.message}</div>
            <button
              type="button"
              onClick={retry}
              className="rounded-md border border-destructive/30 px-2 py-0.5 text-[12px] font-medium transition-colors hover:bg-destructive/10"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <div className={`shrink-0 border-t border-border/60 ${outerPx} pb-4 pt-3`}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="mx-auto w-full max-w-[44rem]"
        >
          <div className="relative rounded-2xl border border-border bg-background transition-colors focus-within:border-foreground/25 focus-within:ring-4 focus-within:ring-foreground/[0.04]">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={disabled}
              placeholder={disabled ? 'Creating chat…' : 'Message the assistant…'}
              className="block w-full resize-none bg-transparent px-4 pt-3 pb-12 leading-[1.5] text-foreground placeholder:text-muted-foreground/60 outline-none disabled:cursor-not-allowed"
            />

            <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-between">
              {groupedModels && modelId && selectedModel ? (
                <ModelPicker
                  grouped={groupedModels}
                  modelId={modelId}
                  label={selectedModel.label}
                  onChange={updateModelId}
                />
              ) : (
                <span />
              )}

              {isLoading ? (
                <button
                  type="button"
                  onClick={stop}
                  aria-label="Stop generating"
                  className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90"
                >
                  <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  aria-label="Send message"
                  className="pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all hover:opacity-90 disabled:bg-muted disabled:text-muted-foreground/60 disabled:cursor-not-allowed"
                >
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}


// ----- Turn rendering ----------------------------------------------------

type ToolInvocationPart = {
  type: 'tool-invocation'
  toolInvocation: ToolInvocation
  toolCallId: string
}

type MessagePart =
  | { type: 'text'; text: string }
  | ToolInvocationPart

interface MessageTurnProps {
  role: 'user' | 'assistant' | 'system'
  content: string
  parts?: unknown[]
  isStreaming: boolean
}

function MessageTurn({ role, content, parts, isStreaming }: MessageTurnProps) {
  const orderedParts: MessagePart[] = useMemo(() => {
    if (Array.isArray(parts) && parts.length > 0) {
      const cast = parts as MessagePart[]
      const hasText = cast.some((p) => (p as { type?: string }).type === 'text')
      if (hasText) return cast
      if (content) return [...cast, { type: 'text', text: content }]
      return cast
    }
    if (content) return [{ type: 'text', text: content }]
    return []
  }, [parts, content])

  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 leading-relaxed text-foreground whitespace-pre-wrap break-words">
          {content}
        </div>
      </div>
    )
  }

  if (role === 'system') {
    // Server compaction wraps summaries in this prefix; strip for display.
    const body = content.replace(/^Earlier conversation summary:\n?/, '')
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
        <div className="mb-1 font-medium tracking-tight text-foreground/80">
          Earlier conversation summary
        </div>
        <div className="whitespace-pre-wrap leading-relaxed">{body}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {orderedParts.map((p, i) => {
        if (p.type === 'text') {
          const text = (p as { text: string }).text
          if (!text) return null
          // Markdown styling without `@tailwindcss/typography`: arbitrary
          // descendant selectors (`[&_p]:my-2`) target the markdown's
          // emitted HTML directly. Avoids a plugin dep on every scaffolded
          // app — `prose` classes emit zero CSS unless typography is
          // installed, which is what made paragraphs / line breaks
          // collapse into one wall of text.
          //
          // Code blocks are always-dark (`bg-zinc-900`) so they stay
          // readable under both light and dark host themes — matches the
          // atom-one-dark hljs palette imported above. Inline `<code>`
          // remains theme-aware via `bg-muted`.
          return (
            <div
              key={i}
              className="text-foreground leading-relaxed
                         [&_p]:my-2 [&_p]:[overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
                         [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:my-3
                         [&_h2]:text-base [&_h2]:font-semibold [&_h2]:my-3
                         [&_h3]:font-semibold [&_h3]:my-2
                         [&_strong]:font-semibold [&_em]:italic
                         [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
                         [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6
                         [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6
                         [&_li]:my-0.5
                         [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground
                         [&_hr]:my-3 [&_hr]:border-border
                         [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.9em]
                         [&_pre]:bg-zinc-900 [&_pre]:text-zinc-100 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:my-2 [&_pre]:overflow-x-auto
                         [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none [&_pre_code]:text-inherit
                         [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse
                         [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold [&_th]:text-left
                         [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                rehypePlugins={[rehypeHighlight]}
                components={{ pre: CodeBlock, a: ExternalLink }}
              >
                {text}
              </ReactMarkdown>
            </div>
          )
        }
        if (p.type === 'tool-invocation') {
          const inv = (p as ToolInvocationPart).toolInvocation
          return <ToolRow key={i} inv={inv} />
        }
        return null
      })}
      {isStreaming && <LiveIndicator />}
    </div>
  )
}

// ----- Empty state --------------------------------------------------------

function EmptyState({ prompts, onPick }: { prompts: string[]; onPick: (p: string) => void }) {
  return (
    <div className="mx-auto flex h-full max-w-[28rem] flex-col items-start justify-center gap-4 px-2">
      <div className="space-y-1">
        <h2 className="text-[17px] font-medium tracking-tight text-foreground">
          How can I help?
        </h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          I can query records, list schemas, and inspect collections on your behalf.
        </p>
      </div>
      <div className="flex flex-col gap-0.5 pt-2">
        <div className="pb-1 text-[10.5px] font-medium tracking-[0.08em] uppercase text-muted-foreground">
          Try
        </div>
        {prompts.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="group flex items-center gap-2 py-1 text-left text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="h-px w-3 shrink-0 bg-border transition-colors group-hover:bg-muted-foreground" />
            <span className="truncate">{p}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ----- Pending + Live indicators -----------------------------------------

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <EllipsisDots />
      <span>Thinking</span>
    </div>
  )
}

function LiveIndicator() {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground" aria-live="polite">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inset-0 rounded-full bg-primary/50 animate-ping" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-primary" />
      </span>
      <span className="tracking-wide">Working</span>
    </div>
  )
}

function EllipsisDots() {
  return (
    <span className="inline-flex items-center gap-[3px]">
      <span className="h-1 w-1 rounded-full bg-muted-foreground animate-[pulse_1.4s_ease-in-out_0ms_infinite]" />
      <span className="h-1 w-1 rounded-full bg-muted-foreground animate-[pulse_1.4s_ease-in-out_180ms_infinite]" />
      <span className="h-1 w-1 rounded-full bg-muted-foreground animate-[pulse_1.4s_ease-in-out_360ms_infinite]" />
    </span>
  )
}

// ----- Tool row ----------------------------------------------------------

type ToolInvocation = {
  toolName: string
  state: 'call' | 'result' | 'partial-call'
  args?: unknown
  result?: { success?: boolean } & Record<string, unknown>
}

// ----- Code block + copy button ------------------------------------------

// `pre` slot for ReactMarkdown — wraps the highlighted <pre><code> with a
// copy-to-clipboard button. Positioned absolutely; revealed on hover via
// `group-hover` so it doesn't add visual noise on every code block.
const CodeBlock: Components['pre'] = ({ children, node: _node, ref: _ref, ...props }) => {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    const text = ref.current?.textContent ?? ''
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        className="absolute right-2 top-2 inline-flex h-6 items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 text-[11px] font-medium text-zinc-200 opacity-0 transition-opacity hover:bg-zinc-700 focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied
          ? <Check className="h-3 w-3" aria-hidden="true" />
          : <Copy className="h-3 w-3" aria-hidden="true" />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <pre ref={ref} {...props}>{children}</pre>
    </div>
  )
}

// Markdown links default to navigating in the same tab — which kills the
// chat session. Force new-tab + noopener for safety.
const ExternalLink: Components['a'] = ({ children, href, node: _node, ...props }) => {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  )
}

function ToolRow({ inv }: { inv: ToolInvocation }) {
  const done = inv.state === 'result'
  const failed = done && inv.result?.success === false
  const running = !done
  const { label, path } = describeTool(inv.toolName, inv.args as Record<string, unknown> | undefined)

  return (
    <div className={`flex items-center gap-2 text-[13px] leading-tight ${running ? 'animate-[pulse_2s_ease-in-out_infinite]' : ''}`}>
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        {running ? <Spinner /> : failed ? <FailDot /> : <Check className="h-3 w-3 shrink-0 text-foreground/60" aria-hidden="true" />}
      </span>
      <span className={running ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
      {path && (
        <code className="truncate font-mono text-[12.5px] text-foreground/70">{path}</code>
      )}
      {running && <EllipsisDots />}
    </div>
  )
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="animate-spin text-foreground/70">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
      <path d="M10.5 6 A 4.5 4.5 0 0 1 6 10.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function FailDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-label="failed" />
}

function describeTool(
  name: string,
  args?: Record<string, unknown>,
): { label: string; path?: string } {
  const collection = typeof args?.collection === 'string' ? args.collection : undefined
  const recordId = typeof args?.recordId === 'string' ? args.recordId : undefined

  switch (name) {
    case 'schema_list':
      return { label: 'Listing collections' }
    case 'schema_describe':
      return { label: 'Describing', path: collection }
    case 'records_query':
      return { label: 'Reading', path: collection }
    case 'records_get':
      return {
        label: 'Fetching',
        path: collection && recordId ? `${collection}/${recordId}` : collection,
      }
    case 'user_current':
      return { label: 'Checking current user' }
    default:
      return { label: 'Running', path: name }
  }
}

// ----- Model picker ------------------------------------------------------

function ModelPicker({
  grouped,
  modelId,
  label,
  onChange,
}: {
  grouped: Array<[string, ModelOption[]]>
  modelId: string
  label: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={containerRef} className="pointer-events-auto relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="max-w-[10rem] truncate">{label}</span>
        <ChevronDown className="h-3 w-3 opacity-70" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-2 w-64 max-h-[22rem] overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          {grouped.map(([provider, items], pIdx) => (
            <div key={provider}>
              {pIdx > 0 && <div className="border-t border-border/60" />}
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {provider}
              </div>
              {items.map((m) => {
                const active = m.id === modelId
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onChange(m.id)
                      setOpen(false)
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                      active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                    }`}
                  >
                    <span className="truncate">{m.label}</span>
                    {active && <Check className="h-3 w-3 shrink-0 text-foreground/60" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ----- Utils -------------------------------------------------------------

function groupModelsByProvider(models?: ModelOption[]): Array<[string, ModelOption[]]> | null {
  if (!models || models.length === 0) return null
  const map = new Map<string, ModelOption[]>()
  for (const m of models) {
    const list = map.get(m.provider) ?? []
    list.push(m)
    map.set(m.provider, list)
  }
  return Array.from(map.entries())
}
