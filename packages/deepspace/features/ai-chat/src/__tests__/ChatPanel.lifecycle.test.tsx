// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../ChatPanel'

const { queryWheres } = vi.hoisted(() => ({
  queryWheres: [] as Array<{ chatId?: string; userId?: string }>,
}))

vi.mock('deepspace', async () => {
  // The SSE codec is pure; run the real one so the stubbed wire bytes below
  // exercise the same decode path production streams take.
  const stream = await vi.importActual<typeof import('@/client/ai-stream')>('@/client/ai-stream')
  return {
    decodeAiStreamChunk: stream.decodeAiStreamChunk,
    parseSseLine: stream.parseSseLine,
    getAuthToken: async () => null,
    listDeepSpaceAgentModels: () => [
      { id: 'model-a', label: 'Model A', providerLabel: 'Provider' },
    ],
    useQuery: (_collection: string, options: { where: { chatId?: string; userId?: string } }) => {
      queryWheres.push(options.where)
      return { records: [] as Array<{ recordId: string; data: Record<string, unknown> }> }
    },
  }
})

// The turn renderer pulls app-level markdown deps (react-markdown,
// remark-breaks) that feature.json ships to scaffolded apps but the SDK
// workspace does not install. This suite is about ChatPanel.tsx's chat
// lifecycle, not rendering — substitute minimal, queryable turns.
vi.mock('../ChatPanel.messages', () => ({
  EmptyState: () => <div data-empty-state="">Empty state</div>,
  MessageTurn: ({ role, content }: { role: string; content: string }) => (
    <div data-turn={role}>{content}</div>
  ),
  ThinkingIndicator: () => <div data-thinking="" />,
}))
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let parentRenders = 0
let chatCreates = 0
let streamBodies: Array<Record<string, unknown>> = []

/**
 * A parent stuck at `chatId={null}` — no `onChatCreated`, no state. The panel
 * must run the whole first-chat lifecycle without a single parent rerender.
 */
function Parent() {
  parentRenders += 1
  return <ChatPanel chatId={null} userId="user-1" />
}

beforeEach(() => {
  parentRenders = 0
  chatCreates = 0
  streamBodies = []
  queryWheres.length = 0

  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0)
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle)
  // jsdom implements no element scrolling; the panel pins its log to the bottom.
  window.HTMLElement.prototype.scrollTo = () => {}

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/ai/chats') {
        chatCreates += 1
        return Response.json({ chat: { recordId: 'chat-new' } })
      }
      if (url === '/api/ai/chat') {
        streamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(
          `data: ${JSON.stringify({ type: 'text-delta', delta: 'Hi.' })}\n\ndata: [DONE]\n\n`,
          { headers: { 'X-Asst-Id': `asst-${streamBodies.length}` } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

/** Drain the send's microtask chain (create → stream → settle) until idle. */
async function flushUntil(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (ready()) return
    await act(async () => {
      await Promise.resolve()
    })
  }
  throw new Error('panel never settled after send')
}

async function sendMessage(content: string): Promise<void> {
  const textarea = container.querySelector('textarea')
  expect(textarea).not.toBeNull()
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setValue?.call(textarea, content)
    textarea?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
  })
  await flushUntil(() => container.querySelector('[aria-label="Send message"]') !== null)
}

describe('ChatPanel first-chat lifecycle with chatId={null}', () => {
  it('renders the first exchange from its own chat without a parent rerender', async () => {
    await act(async () => root.render(<Parent />))
    expect(container.querySelector('[data-empty-state]')).not.toBeNull()

    await sendMessage('Hello from a fresh mount')

    expect(container.querySelector('[data-empty-state]')).toBeNull()
    const turns = [...container.querySelectorAll('[data-turn]')]
    expect(turns.map((turn) => turn.getAttribute('data-turn'))).toEqual(['user', 'assistant'])
    expect(turns[0]?.textContent).toBe('Hello from a fresh mount')
    expect(turns[1]?.textContent).toBe('Hi.')
    expect(parentRenders).toBe(1)

    // The persisted-messages query re-keys onto the promoted chat id.
    expect(queryWheres[0]?.chatId).toBe('__none__')
    expect(queryWheres.at(-1)?.chatId).toBe('chat-new')
  })

  it('reuses the promoted chat for the second send instead of creating another', async () => {
    await act(async () => root.render(<Parent />))

    await sendMessage('First message')
    await sendMessage('Second message')

    expect(chatCreates).toBe(1)
    expect(streamBodies.map((body) => body.chatId)).toEqual(['chat-new', 'chat-new'])
    const userTurns = [...container.querySelectorAll('[data-turn="user"]')]
    expect(userTurns.at(-1)?.textContent).toBe('Second message')
  })
})
