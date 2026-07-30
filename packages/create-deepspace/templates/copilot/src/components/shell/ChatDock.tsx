/**
 * ChatDock — the app-wide AI assistant, docked right of the main panel.
 *
 * A single viewport-level toggle (fixed, top-right) opens and closes it;
 * the button keeps the same position and chrome in both states, so it
 * never appears to move — closed, it floats over the main rectangle's
 * top-right corner. The desktop dock animates its OUTER width to zero,
 * so the rectangle takes the space back; the chat is right-anchored at a
 * fixed width inside a clip layer, sliding in without reflowing its own
 * content. On mobile the chat is a right-side sheet over a backdrop.
 * Only ONE ChatPanel is ever mounted — the container is chosen via
 * matchMedia, not CSS, so queries and auto-creates never run twice.
 *
 * Backed by POST /api/ai/chat (src/ai/chat-routes.ts) and the ai-chats /
 * ai-messages collections. Chats are per-user (RBAC read: 'own'), so
 * signed-out visitors get a sign-in prompt instead of the panel.
 */

import { useEffect, useState } from 'react'
import { PanelRightClose, PanelRightOpen, Plus } from 'lucide-react'
import { useAuth, AuthOverlay } from 'deepspace'
import { ChatPanel } from '../chat/ChatPanel'
import { Button } from '../ui'
import { cn } from '../../lib/utils'

const CHAT_WIDTH = 360
const OPEN_KEY = 'chat-open'

// Desktop opens by default (an explicit close persists); mobile always
// starts closed — a sheet covering the app on first load is hostile.
function readInitialOpen(): boolean {
  if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) return false
  try {
    return localStorage.getItem(OPEN_KEY) !== 'closed'
  } catch {
    return true
  }
}

/** True at the shell's md breakpoint and up. Drives WHICH container the chat
 *  mounts in (inline dock vs mobile sheet) — JS, not CSS classes, so only one
 *  ChatPanel exists at a time. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 768px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}

export function ChatDock() {
  const { isSignedIn, userId } = useAuth()
  const isDesktop = useIsDesktop()

  const [open, setOpen] = useState(readInitialOpen)
  const [chatId, setChatId] = useState<string | null>(null)
  const [showAuthModal, setShowAuthModal] = useState(false)

  // A chat id must never survive an account switch: the next user's first
  // send would 404 against a chat they can't read.
  useEffect(() => {
    setChatId(null)
  }, [userId])

  // Persist only explicit choices — never the device-based initial state.
  const setOpenPersist = (next: boolean) => {
    setOpen(next)
    try {
      localStorage.setItem(OPEN_KEY, next ? 'open' : 'closed')
    } catch { /* private mode — state just won't persist */ }
  }

  // Mobile sheet: Escape closes (the desktop dock is a layout panel, not a
  // popover — it stays put on Escape).
  useEffect(() => {
    if (isDesktop || !open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenPersist(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDesktop, open])

  // pr-12 keeps the title and new-chat clear of the fixed corner toggle.
  const chat = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 flex-none items-center gap-1 pl-3 pr-12">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">Assistant</span>
        {isSignedIn && userId && (
          <button
            type="button"
            onClick={() => setChatId(null)}
            title="New chat"
            aria-label="New chat"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      {isSignedIn && userId ? (
        /* !bg-transparent: the panel bakes in bg-background; the chat is
           content floating on the shell (desktop) or on the sheet's own
           surface (mobile) — never a second card. */
        <ChatPanel
          chatId={chatId}
          userId={userId}
          onChatCreated={setChatId}
          className="min-h-0 flex-1 !bg-transparent"
          compact
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-muted-foreground">Sign in to use the assistant.</p>
          <Button size="sm" onClick={() => setShowAuthModal(true)}>
            Sign in
          </Button>
        </div>
      )}
    </div>
  )

  return (
    <>
      {/* Desktop: inline dock column. The outer div animates width so the
          rectangle reflows smoothly; the chat is right-anchored at a fixed
          width inside a clip layer, so it slides without reflowing.
          Outer width = chat + 8px shell gutter. */}
      {isDesktop && (
        <aside
          aria-label="Assistant"
          style={{ width: open ? CHAT_WIDTH + 8 : 0 }}
          className="relative h-full shrink-0 transition-[width] duration-200 ease-out"
        >
          {/* The chat stays MOUNTED while closed (clipped to zero width,
              inert) — unmounting would abort an in-flight assistant turn
              and lose the pending message. Closing is a layout toggle. */}
          <div
            inert={!open}
            style={{ opacity: open ? 1 : 0 }}
            className="absolute bottom-2 left-0 right-2 top-2 overflow-hidden transition-opacity duration-200"
          >
            <div className="absolute inset-y-0 right-0" style={{ width: CHAT_WIDTH }}>
              {chat}
            </div>
          </div>
        </aside>
      )}

      {/* Mobile: right-side sheet over a backdrop. Like the desktop dock, the
          sheet stays MOUNTED while closed (invisible, inert) — unmounting on
          close would abort an in-flight assistant turn and, since the server
          persists only in onFinish, permanently lose the pending message.
          (Crossing the md breakpoint still swaps containers and remounts —
          rare enough that we accept it rather than merge the two layouts.) */}
      {!isDesktop && (
        <div
          inert={!open}
          role="dialog"
          aria-modal="true"
          aria-label="Assistant"
          className={cn('fixed inset-0 z-[75]', !open && 'pointer-events-none')}
        >
          {open && (
            <div className="absolute inset-0 bg-black/40" onClick={() => setOpenPersist(false)} aria-hidden />
          )}
          <div
            style={{ opacity: open ? 1 : 0 }}
            className="absolute inset-y-2 right-2 flex w-[min(400px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-border bg-shell-panel shadow-lg transition-opacity duration-200"
          >
            {chat}
          </div>
        </div>
      )}

      {/* Single viewport-level toggle — same position/chrome in both states;
          only the icon swaps, so it never appears to move. Closed, it sits
          over the main rectangle's top-right corner. */}
      <button
        type="button"
        onClick={() => setOpenPersist(!open)}
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        aria-expanded={open}
        title={open ? 'Close assistant' : 'Open assistant'}
        className={cn(
          'fixed right-3 top-2.5 z-40 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:right-4 md:top-4',
          // Above the open sheet (z-75) so it can close it; when closed it
          // must stay BELOW the kit's dialogs and the nav drawer (z-50).
          open && 'max-md:z-[76]',
        )}
      >
        {open ? (
          <PanelRightClose className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>

      {showAuthModal && <AuthOverlay onClose={() => setShowAuthModal(false)} />}
    </>
  )
}
