import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'
import {
  decodeAiStreamChunk,
  getAuthToken,
  parseSseLine,
  type AiStreamAction,
} from 'deepspace'

export type ToolInvocation = {
  toolName: string
  state: 'call' | 'result'
  args?: unknown
  result?: unknown
}

export type ToolInvocationPart = {
  type: 'tool-invocation'
  toolInvocation: ToolInvocation
  toolCallId: string
}

export type MessagePart =
  | { type: 'text'; text: string }
  | ToolInvocationPart

export type InFlightMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  parts: MessagePart[]
  /** The persisted assistant record id returned in `X-Asst-Id`. */
  serverId?: string
  /** Prevents an old chat's overlay from leaking into the active chat. */
  forChatId: string
}

type UseStreamingChatOptions = {
  chatId: string | null
  modelId?: string
  onChatCreated?: (id: string) => void
}

/**
 * Applies one decoded stream action to the in-flight overlay.
 *
 * This is deliberately pure: the SDK owns wire decoding, this reducer owns
 * overlay semantics, and the hook below owns transport and React lifecycle.
 */
export function reduceStreamMessages(
  messages: InFlightMessage[],
  action: AiStreamAction,
  assistantId: string,
): InFlightMessage[] {
  switch (action.type) {
    case 'append-text':
      return messages.map((message) => {
        if (message.id !== assistantId) return message
        const last = message.parts[message.parts.length - 1]
        const parts: MessagePart[] = last?.type === 'text'
          ? [
              ...message.parts.slice(0, -1),
              { type: 'text', text: last.text + action.delta },
            ]
          : [...message.parts, { type: 'text', text: action.delta }]
        return {
          ...message,
          content: message.content + action.delta,
          parts,
        }
      })

    case 'upsert-tool-call':
      return upsertToolInvocation(messages, assistantId, action.toolCallId, {
        toolName: action.toolName,
        state: 'call',
        args: action.input,
      })

    case 'finalize-tool-call':
      return finalizeToolInvocation(
        messages,
        assistantId,
        action.toolCallId,
        action.result,
      )

    case 'fail-tool-input':
      return upsertToolInvocation(messages, assistantId, action.toolCallId, {
        toolName: action.toolName,
        state: 'result',
        args: action.input,
        result: { success: false, error: action.errorText },
      })

    case 'fail-tool-output':
      return finalizeToolInvocation(messages, assistantId, action.toolCallId, {
        success: false,
        error: action.errorText,
      })

    case 'stream-error':
    case 'abort':
      // Preserve partial text or a tool row the user has already seen, but do
      // not leave an empty failed/stopped assistant occupying layout space.
      return messages.filter(
        (message) => message.id !== assistantId || message.parts.length > 0,
      )

    default: {
      const exhaustive: never = action
      return exhaustive
    }
  }
}

function upsertToolInvocation(
  messages: InFlightMessage[],
  assistantId: string,
  toolCallId: string,
  invocation: ToolInvocation,
): InFlightMessage[] {
  const part: ToolInvocationPart = {
    type: 'tool-invocation',
    toolInvocation: invocation,
    toolCallId,
  }

  return messages.map((message) => {
    if (message.id !== assistantId) return message
    const index = message.parts.findIndex(
      (candidate) =>
        candidate.type === 'tool-invocation' && candidate.toolCallId === toolCallId,
    )
    if (index < 0) return { ...message, parts: [...message.parts, part] }

    const parts = message.parts.slice()
    parts[index] = part
    return { ...message, parts }
  })
}

function finalizeToolInvocation(
  messages: InFlightMessage[],
  assistantId: string,
  toolCallId: string,
  result: unknown,
): InFlightMessage[] {
  return messages.map((message) => {
    if (message.id !== assistantId) return message
    const parts = message.parts.map((part): MessagePart => {
      if (part.type !== 'tool-invocation' || part.toolCallId !== toolCallId) {
        return part
      }
      return {
        ...part,
        toolInvocation: {
          ...part.toolInvocation,
          state: 'result',
          result,
        },
      }
    })
    return { ...message, parts }
  })
}

export function useStreamingChat({
  chatId,
  modelId,
  onChatCreated,
}: UseStreamingChatOptions) {
  const [inFlight, setInFlight] = useState<InFlightMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const isLoadingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const assistantIdRef = useRef<string | null>(null)
  const lastSendRef = useRef<string | null>(null)
  const previousChatIdRef = useRef<string | null>(chatId)

  useEffect(() => {
    const previousChatId = previousChatIdRef.current
    previousChatIdRef.current = chatId
    // `null -> id` is the auto-create promotion during the first send. Every
    // transition away from a real id is a genuine switch and aborts its turn.
    if (previousChatId !== null && previousChatId !== chatId) {
      abortRef.current?.abort()
      setInFlight([])
    }
  }, [chatId])

  useEffect(() => () => abortRef.current?.abort(), [])

  const send = useCallback(
    async (content: string) => {
      // Claim the slot synchronously so two first sends cannot create two chats.
      if (isLoadingRef.current) return
      isLoadingRef.current = true
      setIsLoading(true)
      setError(null)
      lastSendRef.current = content

      const controller = new AbortController()
      abortRef.current = controller
      let assistantId: string | null = null
      try {
        let activeChatId = chatId
        if (!activeChatId) {
          activeChatId = await createChat(controller.signal)
          if (controller.signal.aborted) return
          onChatCreated?.(activeChatId)
        }

        const localTimestamp = Date.now()
        const userMessageId =
          `usr-${localTimestamp}-${Math.random().toString(36).slice(2, 8)}`
        assistantId = `asst-pending-${localTimestamp}`
        assistantIdRef.current = assistantId
        setInFlight([
          {
            id: userMessageId,
            role: 'user',
            content,
            parts: [],
            forChatId: activeChatId,
          },
          {
            id: assistantId,
            role: 'assistant',
            content: '',
            parts: [],
            forChatId: activeChatId,
          },
        ])

        const token = await getAuthToken()
        const response = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({
            chatId: activeChatId,
            userMessageId,
            content,
            modelId,
          }),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          const detail = response.body
            ? await response.text().catch(() => '')
            : ''
          throw new Error(detail || `Request failed: ${response.status}`)
        }

        const serverId = response.headers.get('X-Asst-Id')
        if (serverId) {
          setInFlight((messages) =>
            messages.map((message) =>
              message.id === assistantId ? { ...message, serverId } : message,
            ),
          )
        }

        await consumeStream(response.body, assistantId, setInFlight, setError)
      } catch (cause) {
        const streamError = toError(cause)
        // A local abort does not necessarily deliver an SSE `abort` event.
        // Apply the same overlay rule immediately for stop and transport errors.
        if (assistantId) {
          const failedAssistantId = assistantId
          setInFlight((messages) =>
            reduceStreamMessages(messages, { type: 'abort' }, failedAssistantId),
          )
        }
        if (streamError.name !== 'AbortError') {
          console.error('[chat] STREAM error', {
            name: streamError.name,
            message: streamError.message,
          })
          setError(streamError)
        }
      } finally {
        if (assistantId && assistantIdRef.current === assistantId) {
          assistantIdRef.current = null
        }
        if (abortRef.current === controller) abortRef.current = null
        isLoadingRef.current = false
        setIsLoading(false)
      }
    },
    [chatId, modelId, onChatCreated],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    const assistantId = assistantIdRef.current
    if (assistantId) {
      setInFlight((messages) =>
        reduceStreamMessages(messages, { type: 'abort' }, assistantId),
      )
    }
  }, [])

  const retry = useCallback(() => {
    if (lastSendRef.current) void send(lastSendRef.current)
  }, [send])

  return { send, stop, retry, isLoading, error, inFlight }
}

async function createChat(signal: AbortSignal): Promise<string> {
  const token = await getAuthToken()
  const response = await fetch('/api/ai/chats', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({}),
    signal,
  })
  if (!response.ok) throw new Error(`Failed to create chat: ${response.status}`)
  const data = (await response.json()) as { chat?: { recordId?: unknown } }
  if (typeof data.chat?.recordId !== 'string') {
    throw new Error('Failed to create chat: response is missing chat.recordId')
  }
  return data.chat.recordId
}

function authHeaders(token: string | null): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  assistantId: string,
  setInFlight: Dispatch<SetStateAction<InFlightMessage[]>>,
  setError: Dispatch<SetStateAction<Error | null>>,
) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      applySseLine(line, assistantId, setInFlight, setError)
    }
  }

  buffer += decoder.decode()
  applySseLine(buffer, assistantId, setInFlight, setError)
}

function applySseLine(
  line: string,
  assistantId: string,
  setInFlight: Dispatch<SetStateAction<InFlightMessage[]>>,
  setError: Dispatch<SetStateAction<Error | null>>,
) {
  const chunk = parseSseLine(line)
  if (!chunk) return
  const action = decodeAiStreamChunk(chunk)
  if (!action) return

  if (action.type === 'stream-error') {
    console.error('[chat] STREAM error', action.errorText)
    setError(new Error(action.errorText))
  } else if (action.type === 'fail-tool-input') {
    console.error('[chat] STREAM tool-input-error', {
      toolCallId: action.toolCallId,
      errorText: action.errorText,
    })
  } else if (action.type === 'fail-tool-output') {
    console.error('[chat] STREAM tool-output-error', {
      toolCallId: action.toolCallId,
      errorText: action.errorText,
    })
  }

  setInFlight((messages) => reduceStreamMessages(messages, action, assistantId))
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
