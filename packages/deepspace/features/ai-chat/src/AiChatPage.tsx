/**
 * AiChatPage — app shell with a chat card on the right (mirrors Miyagi's
 * create-mode chat layout).
 *
 * Layout:
 *   [ app card, flex-1 ]  [gap]  [ chat card ]
 *
 * The chat card has a header bar at the top with the editable title on the
 * left and three action icons on the right: New chat, History, Close.
 * Chat history is a slide-in overlay (not an inline rail) — clicking the
 * History icon overlays the chat panel with a list of past conversations.
 * When the chat is closed, a single floating button at the top-right of
 * the page reopens it.
 *
 * - Chat card: width animates 0 ↔ chatWidth. Inner content is absolutely
 *   positioned at fixed width so the panel doesn't reflow during the
 *   width animation — it just gets clipped by the card's overflow.
 * - Resize handle sits on the chat card's left edge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  History,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  X,
} from 'lucide-react'
import { useAuth, AuthOverlay, getAuthToken, useQuery } from 'deepspace'
// Paths resolve post-install (page → src/pages/, components → src/components/).
import { ChatPanel } from '../components/ChatPanel'

const CHAT_W_MIN = 320
const CHAT_W_MAX = 720
const CHAT_W_DEFAULT = 380
const STORAGE_OPEN = 'ai-chat-open'
const STORAGE_WIDTH = 'ai-chat-width'

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

interface ChatRow {
  userId: string
  title?: string
}

function loadOpen(): boolean {
  try { return localStorage.getItem(STORAGE_OPEN) !== '0' } catch { return true }
}
function loadWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_WIDTH) ?? '', 10)
    if (!isNaN(v) && v >= CHAT_W_MIN && v <= CHAT_W_MAX) return v
  } catch { /* ignore */ }
  return CHAT_W_DEFAULT
}
// Compact relative timestamp: now / 5m / 3h / 2d / 3w. Falls back to '' when
// the input isn't a parseable ISO string.
function formatRelative(ts?: string): string {
  if (!ts) return ''
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return ''
  const diff = Math.max(0, Date.now() - t)
  if (diff < 60_000) return 'now'
  const m = Math.floor(diff / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

export default function AiChatPage() {
  const { isLoaded, isSignedIn, userId } = useAuth()
  const [showAuth, setShowAuth] = useState(false)
  const [activeChatId, setActiveChatId] = useState<string | null>(null)

  const [chatOpen, setChatOpen] = useState<boolean>(loadOpen)
  const [chatWidth, setChatWidth] = useState<number>(loadWidth)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [creatingChat, setCreatingChat] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const chatCardRef = useRef<HTMLDivElement>(null)

  useEffect(() => { try { localStorage.setItem(STORAGE_OPEN, chatOpen ? '1' : '0') } catch { /* ignore */ } }, [chatOpen])
  useEffect(() => { try { localStorage.setItem(STORAGE_WIDTH, String(chatWidth)) } catch { /* ignore */ } }, [chatWidth])

  const { records: chatsRaw } = useQuery<ChatRow>('ai-chats', {
    where: { userId: userId ?? '__none__' },
    orderBy: 'updatedAt',
    orderDir: 'desc',
    limit: 50,
  })

  // Re-sort newest-first on the client. The SDK's useQuery applies orderBy
  // server-side at the initial fetch but appends WebSocket-broadcasted
  // inserts to the tail of the local cache, so without this a freshly-
  // created chat would land at the bottom until the next page refresh.
  const chats = useMemo(() => {
    return [...chatsRaw].sort((a, b) => {
      const aT = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0
      const bT = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0
      return bT - aT
    })
  }, [chatsRaw])

  const activeChat = useMemo(
    () => chats.find((c) => c.recordId === activeChatId) ?? null,
    [chats, activeChatId],
  )
  const activeTitle = (activeChat?.data.title ?? '').trim() || (activeChatId ? 'Untitled' : 'New chat')

  // Resize drag — instant width updates while dragging (no transition).
  // Window blur and visibility loss force-end the drag so the body cursor
  // never gets stuck on `col-resize` if the user alt-tabs mid-drag.
  useEffect(() => {
    if (!dragging) return
    function onMove(e: MouseEvent) {
      if (!chatCardRef.current) return
      // Width is the distance from mouse-x to the chat card's right edge.
      // The rail sits to the right of this card on the page background and
      // is not part of the chat width any more.
      const rect = chatCardRef.current.getBoundingClientRect()
      const raw = rect.right - e.clientX
      setChatWidth(Math.max(CHAT_W_MIN, Math.min(CHAT_W_MAX, raw)))
    }
    function endDrag() { setDragging(false) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', endDrag)
    window.addEventListener('blur', endDrag)
    document.addEventListener('visibilitychange', endDrag)
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', endDrag)
      window.removeEventListener('blur', endDrag)
      document.removeEventListener('visibilitychange', endDrag)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
  }, [dragging])

  const handleSelect = useCallback((id: string) => {
    setActiveChatId(id)
    setChatOpen(true)
    setHistoryOpen(false)
  }, [])

  // Stable callback for the history overlay's onClose. Without this, an
  // inline arrow would change identity on every parent re-render and the
  // overlay's focus-management effect (which lists onClose in its deps)
  // would re-fire on every WS broadcast — losing the user's tab position.
  const closeHistory = useCallback(() => setHistoryOpen(false), [])

  const handleNew = useCallback(async () => {
    // Eager create: row appears in the sidebar at click-time. We set chatId
    // to null up front so the panel renders the empty state immediately,
    // and flip `creatingChat` so the panel's input is suspended — without
    // that gate a fast typist could send before our POST resolves and the
    // panel would also auto-create, spawning a second chat.
    setActiveChatId(null)
    setChatOpen(true)
    setHistoryOpen(false)
    setCreateError(null)
    setCreatingChat(true)
    try {
      const token = await getAuthToken()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch('/api/ai/chats', { method: 'POST', headers })
      if (!res.ok) throw new Error(`create chat failed: ${res.status}`)
      const data = (await res.json()) as { chat?: { id?: string } }
      if (data.chat?.id) setActiveChatId(data.chat.id)
    } catch (err) {
      console.error('[ai-chat-page] create chat failed:', err)
      setCreateError(err instanceof Error ? err.message : 'Failed to create chat')
    } finally {
      setCreatingChat(false)
    }
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    // Don't clear `activeChatId` until the DELETE actually succeeds: if it
    // fails, the row stays in the user's sidebar (because useQuery still
    // reflects it server-side) and we don't want the UI to mislead the user
    // into thinking it's gone. The chat-switch effect in ChatPanel aborts
    // any in-flight stream when activeChatId flips id→null, so the orphan
    // assistant write we'd otherwise produce on cascade-delete is prevented
    // by F1 (abort on id→null) — not by ordering this call before the fetch.
    try {
      const token = await getAuthToken()
      const headers: Record<string, string> = {}
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch(`/api/ai/chats/${id}`, { method: 'DELETE', headers })
      if (!res.ok) throw new Error(`delete failed: ${res.status}`)
      setActiveChatId((cur) => (cur === id ? null : cur))
    } catch (err) {
      console.error('[ai-chat-page] delete failed:', err)
      setCreateError(err instanceof Error ? `Couldn't delete chat: ${err.message}` : "Couldn't delete chat")
    }
  }, [])

  const handleRename = useCallback(async (id: string, title: string) => {
    try {
      const token = await getAuthToken()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await fetch(`/api/ai/chats/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title }),
      })
      if (!res.ok) throw new Error(`rename failed: ${res.status}`)
    } catch (err) {
      console.error('[ai-chat-page] rename failed:', err)
    }
  }, [])

  if (!isLoaded) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading...
      </div>
    )
  }

  if (!isSignedIn || !userId) {
    return (
      <>
        <div className="flex h-full items-center justify-center px-4">
          <div className="max-w-md space-y-4 text-center">
            <h2 className="text-xl font-semibold text-foreground">Sign in to use the assistant</h2>
            <p className="text-sm text-muted-foreground">
              The AI assistant inspects live app data using your permissions.
            </p>
            <button
              onClick={() => setShowAuth(true)}
              className="rounded-full bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Sign in
            </button>
          </div>
        </div>
        {showAuth && <AuthOverlay onClose={() => setShowAuth(false)} />}
      </>
    )
  }

  const chatCardW = chatOpen ? chatWidth : 0

  return (
    <div className="relative flex h-full min-h-0 w-full gap-2 bg-muted/40 p-2">
      <div className="flex h-full min-h-0 flex-1 items-center justify-center rounded-xl border border-border bg-background">
        <div className="max-w-md space-y-2 px-8 text-center">
          <h2 className="text-lg font-medium tracking-tight text-foreground">Your app content</h2>
          <p className="text-sm text-muted-foreground">
            Talk to the assistant on the right — it can query your data with server-side tools.
          </p>
        </div>
      </div>

      {/* Chat region — no card chrome (matches Miyagi: transparent container,
          no border, no shadow, no rounded corners). The chat is just content
          laid out vertically; the only visible separator from the app card is
          the gap and the resize handle's hover line. */}
      <div
        ref={chatCardRef}
        style={{
          width: chatCardW,
          marginLeft: chatOpen ? 0 : -8,
          transition: dragging ? 'none' : `width 220ms ${EASE}, margin-left 220ms ${EASE}`,
        }}
        className="relative h-full shrink-0"
      >
        {chatOpen && <ResizeHandle onStart={() => setDragging(true)} dragging={dragging} />}

        {/* Inner clip layer holds ONLY the chat panel — keeping the history
            overlay outside this layer means its mount/unmount can't disturb
            the right-anchored chat panel's layout (which used to cause a
            visible "slide-left-and-back" sweep on the chat content). */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute inset-y-0 right-0" style={{ width: chatWidth }}>
            <ChatPanel
              chatId={activeChatId}
              userId={userId}
              onChatCreated={setActiveChatId}
              disabled={creatingChat}
              className="!bg-transparent"
              compact
              header={
                <>
                  <ChatHeaderBar
                    chatId={activeChatId}
                    title={activeTitle}
                    onRename={handleRename}
                    onNew={handleNew}
                    onHistory={() => setHistoryOpen(true)}
                  />
                  {createError && (
                    <div role="alert" className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
                      <div className="flex items-start gap-2">
                        <span className="flex-1 leading-relaxed">{createError}</span>
                        <button
                          type="button"
                          onClick={() => { void handleNew() }}
                          className="rounded-md border border-destructive/30 px-2 py-0.5 text-[12px] font-medium hover:bg-destructive/10"
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() => setCreateError(null)}
                          aria-label="Dismiss"
                          className="rounded-md px-1 text-[14px] leading-none hover:bg-destructive/10"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  )}
                </>
              }
            />
          </div>
        </div>
      </div>

      {/* History overlay — sibling of app-card / chat-card in the outer
          flex (NOT inside chat-card). `position: absolute` inherits the
          outer flex's padding edges, so the panel lines up with the chat
          region's vertical bounds (top: 8, bottom: 8) instead of stretching
          to the viewport. Living outside chat-card also keeps its
          mount/unmount animation from disturbing the chat panel's layout. */}
      <ChatHistoryOverlay
        open={historyOpen}
        chats={chats}
        activeChatId={activeChatId}
        onClose={closeHistory}
        onSelect={handleSelect}
        onDelete={handleDelete}
      />

      {/* Single page-level toggle — same button in both states, just swaps
          the icon. Position and chrome are identical when chat is open vs
          closed, so toggling never moves the button visually. The chat
          region animates open/closed behind it. */}
      <PanelToggleButton
        open={chatOpen}
        onClick={() => setChatOpen((o) => !o)}
      />
    </div>
  )
}

// ============================================================================
// Chat header bar — title on the left, action icons on the right.
// Mirrors Miyagi's FloatingChatHeader (`title | new chat | history | close`).
// ============================================================================

function ChatHeaderBar({
  chatId, title, onRename, onNew, onHistory,
}: {
  chatId: string | null
  title: string
  onRename: (id: string, title: string) => Promise<void>
  onNew: () => void
  onHistory: () => void
}) {
  // pr-12 leaves room for the page-level toggle button that floats at the
  // top-right corner. Without this, [history] would sit at the same x as
  // the toggle and they'd visually overlap.
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 pl-2 pr-12">
      <div className="min-w-0 flex-1">
        <ChatTitleBar chatId={chatId} title={title} onRename={onRename} />
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderIconButton label="New chat" onClick={onNew}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </HeaderIconButton>
        <HeaderIconButton label="History" onClick={onHistory}>
          <History className="h-3.5 w-3.5" aria-hidden="true" />
        </HeaderIconButton>
      </div>
    </div>
  )
}

function HeaderIconButton({
  label, onClick, children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}

// ============================================================================
// Chat history overlay — slides in from the right inside the chat card.
// Mirrors Miyagi's ChatHistoryModal (slide-in side panel with gradient backdrop).
// ============================================================================

function ChatHistoryOverlay({
  open, chats, activeChatId, onClose, onSelect, onDelete,
}: {
  open: boolean
  chats: Array<{ recordId: string; data: ChatRow; createdAt?: string; updatedAt?: string }>
  activeChatId: string | null
  onClose: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => Promise<void>
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // Dialog basics: Escape closes; focus moves to the close button on open and
  // returns to the previously-focused element on close. Without this the
  // overlay traps keyboard users (the trigger is hidden behind it).
  useEffect(() => {
    if (!open) return
    const prevFocus = document.activeElement as HTMLElement | null
    closeButtonRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prevFocus?.focus?.()
    }
  }, [open, onClose])

  // Mirrors Miyagi's ChatHistoryModal exactly: a conditional render with no
  // framer-motion, no AnimatePresence, no transforms. Click outside the
  // panel closes (the outer div's onClick); the panel itself stops
  // propagation. Earlier framer-motion versions caused the chat panel to
  // appear to slide left-and-back because their layout calculations +
  // backdrop-filter compositing inside the page tree disturbed the
  // chat-card's layout context. Static positioning has none of that risk.
  if (!open) return null

  return (
    <div
      className="absolute inset-2 z-40 flex justify-end"
      onClick={onClose}
    >
      <div
        className="absolute inset-0"
        style={{
          // Theme-neutral dim — modal backdrops conventionally use a flat
          // dark tint regardless of theme. Gradient leans heavier on the
          // right (where the panel sits) so the app card on the left stays
          // mostly visible.
          background:
            'linear-gradient(270deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.35) 35%, rgba(0,0,0,0.15) 100%)',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
        }}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Chat history"
        onClick={(e) => e.stopPropagation()}
        className="relative flex h-full w-full max-w-[320px] flex-col rounded-2xl border border-border/40 bg-background/95"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <div className="flex shrink-0 items-center justify-between px-4 py-3">
          <span className="text-[12px] font-semibold tracking-wide text-foreground">
            History
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close history"
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          {chats.length === 0 ? (
            <div className="text-[12px] text-muted-foreground">
              No previous conversations.
            </div>
          ) : (
            chats.map((chat) => (
              <ChatHistoryRow
                key={chat.recordId}
                title={chat.data.title}
                timestamp={formatRelative(chat.updatedAt ?? chat.createdAt)}
                active={chat.recordId === activeChatId}
                onSelect={() => onSelect(chat.recordId)}
                onDelete={() => onDelete(chat.recordId)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function ChatHistoryRow({
  title, timestamp, active, onSelect, onDelete,
}: {
  title?: string
  timestamp: string
  active: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const display = (title ?? '').trim() || 'Untitled'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() }
      }}
      className={`group relative flex w-full shrink-0 cursor-pointer flex-col rounded-lg border border-transparent px-3 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/20 ${
        active
          ? 'border-border/60 bg-muted'
          : 'hover:border-border hover:bg-muted/60'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 truncate text-[12px] ${active ? 'font-semibold text-foreground' : 'font-medium text-foreground/90'}`}>
          {display}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          aria-label={`Delete ${display}`}
          tabIndex={-1}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      {timestamp && (
        <span className="mt-0.5 text-[10px] tabular-nums text-foreground/60">
          {timestamp}
        </span>
      )}
    </div>
  )
}

// ============================================================================
// Panel toggle — single fixed button at top-right that swaps its icon based
// on chatOpen. Position, size, and chrome are identical in both states so
// the button NEVER appears to move when toggled — only the chat region
// animates open/closed behind it.
// ============================================================================

function PanelToggleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  const label = open ? 'Close assistant' : 'Open assistant'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="absolute z-30 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      style={{ right: 16, top: 16 }}
    >
      {open
        ? <PanelRightClose className="h-3.5 w-3.5" aria-hidden="true" />
        : <PanelRightOpen className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  )
}

// ============================================================================
// Editable title bar (no border-b — clean, no extra boxes)
// ============================================================================

function ChatTitleBar({
  chatId, title, onRename,
}: {
  chatId: string | null
  title: string
  onRename: (id: string, title: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync draft to the latest title — but skip while the user is actively
  // editing, otherwise an incoming server-side rename (e.g. auto-title) would
  // clobber their in-progress text under the cursor.
  useEffect(() => {
    if (!editing) setDraft(title)
  }, [title, editing])
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  function commit() {
    if (!editing) return
    setEditing(false)
    const next = draft.trim()
    if (chatId && next && next !== title) void onRename(chatId, next)
    else setDraft(title)
  }

  if (!chatId) {
    return (
      <div className="flex h-9 min-w-0 items-center px-2 text-[13px] text-muted-foreground">
        {title}
      </div>
    )
  }

  if (editing) {
    return (
      <div className="flex h-9 min-w-0 items-center px-2">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            if (e.key === 'Escape') { setDraft(title); setEditing(false) }
          }}
          className="block w-full bg-transparent text-[13px] font-medium text-foreground outline-none"
        />
      </div>
    )
  }

  return (
    <div className="flex h-9 min-w-0 items-center px-2">
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename chat"
        className="group inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5"
      >
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground/85">
          {title}
        </span>
        <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100" aria-hidden="true" />
      </button>
    </div>
  )
}

// ============================================================================
// Resize handle
// ============================================================================

function ResizeHandle({ onStart, dragging }: { onStart: () => void; dragging: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={(e) => { e.preventDefault(); onStart() }}
      className="group absolute -left-2 top-0 z-20 h-full w-2 cursor-col-resize"
    >
      <span
        className={`pointer-events-none absolute inset-y-2 left-1/2 w-px -translate-x-1/2 transition-colors ${
          dragging ? 'bg-primary' : 'bg-transparent group-hover:bg-border'
        }`}
      />
    </div>
  )
}

