/**
 * PlatformProvider — Zero-cost context for platform worker integration.
 *
 * Always present in the component tree (via template main.tsx), but only
 * activates expensive features (WebSocket connections, polling) when a
 * component subscribes via the corresponding hook.
 *
 * Always available (zero overhead):
 *   platformFetch(path, init) — authenticated fetch, prepends /platform
 *
 * Subscription-activated (zero cost until first subscriber):
 *   useInbox() — inbox entries from InboxRoom WebSocket
 *
 * Auth uses getAuthToken() from deepspace on demand.
 * The template already provides DeepSpaceAuthProvider.
 *
 * Usage:
 *   import { PlatformProvider, usePlatform, useInbox } from 'deepspace'
 *
 *   // Already in template main.tsx:
 *   <PlatformProvider>
 *     <App />
 *   </PlatformProvider>
 *
 *   // In any component:
 *   const { platformFetch } = usePlatform()
 *   const inbox = useInbox() // activates WebSocket on mount
 */

import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react'
import { getAuthToken } from '../auth/token'

export interface InboxEntry {
  conversationId: string
  scope: {
    type: string
    participants?: string[]
    appId?: string
    contentRef?: string
    ticketNumber?: string
  }
  displayName: string
  muted: boolean
  joinedAt: string
  lastMessageAt: string | null
  lastMessagePreview: string | null
  lastMessageAuthor: string | null
  unreadCount: number
}

export interface PlatformContextValue {
  /** Authenticated fetch — prepends /platform, sets Authorization + Content-Type */
  platformFetch: (path: string, init?: RequestInit) => Promise<Response>
  /** Subscribe to inbox — returns unsubscribe. Internal use by useInbox(). */
  subscribeInbox: () => () => void
  /** Current inbox entries (populated when at least one subscriber is active) */
  inbox: InboxEntry[]
}

export const PlatformContext = createContext<PlatformContextValue | null>(null)

export function usePlatform(): PlatformContextValue {
  const ctx = useContext(PlatformContext)
  if (!ctx) throw new Error('usePlatform must be used within a PlatformProvider')
  return ctx
}

/**
 * Subscribe to inbox entries from the InboxRoom WebSocket.
 * The WebSocket connects when the first component calls useInbox()
 * and disconnects when the last one unmounts.
 */
export function useInbox(): InboxEntry[] {
  const { inbox, subscribeInbox } = usePlatform()
  useEffect(() => subscribeInbox(), [subscribeInbox])
  return inbox
}

export function PlatformProvider({ children }: { children: React.ReactNode }) {
  const [inbox, setInbox] = useState<InboxEntry[]>([])

  // --- Subscription-activated inbox WebSocket ---
  const inboxSubscribers = useRef(0)
  const [inboxActive, setInboxActive] = useState(false)

  const subscribeInbox = useCallback(() => {
    inboxSubscribers.current++
    if (inboxSubscribers.current === 1) setInboxActive(true)
    return () => {
      inboxSubscribers.current--
      if (inboxSubscribers.current === 0) setInboxActive(false)
    }
  }, [])

  useEffect(() => {
    if (!inboxActive) return

    let mounted = true
    let ws: WebSocket | null = null
    let pingInterval: ReturnType<typeof setInterval> | undefined
    let retryTimer: ReturnType<typeof setTimeout>

    async function connect() {
      const token = await getAuthToken()
      if (!mounted) return
      if (!token) {
        // Auth not ready yet — retry
        retryTimer = setTimeout(connect, 2_000)
        return
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      ws = new WebSocket(
        `${protocol}//${window.location.host}/platform/ws/inbox?token=${encodeURIComponent(token)}`,
      )

      ws.onmessage = (e) => {
        if (e.data === 'pong') return
        try {
          const msg = JSON.parse(e.data)
          switch (msg.type) {
            case 'inbox_init':
              setInbox(msg.entries)
              break
            case 'inbox_added':
              setInbox((prev) => [...prev, msg.entry])
              break
            case 'inbox_removed':
              setInbox((prev) => prev.filter((x) => x.conversationId !== msg.conversationId))
              break
            case 'inbox_updated':
              setInbox((prev) =>
                prev.map((x) => (x.conversationId === msg.entry.conversationId ? msg.entry : x)),
              )
              break
          }
        } catch {
          // ignore
        }
      }

      ws.onclose = () => {
        // Stop pinging the dead socket — otherwise each reconnect stacks
        // another interval that outlives its WebSocket.
        clearInterval(pingInterval)
        pingInterval = undefined
        if (mounted) {
          // Reconnect after brief delay
          retryTimer = setTimeout(connect, 3_000)
        }
      }

      // Clear any prior interval before starting a new one (defensive — a
      // reconnect goes through onclose, but this keeps the single-interval
      // invariant even if connect() is ever called twice).
      clearInterval(pingInterval)
      pingInterval = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send('ping')
      }, 30_000)
    }

    connect()

    return () => {
      mounted = false
      clearTimeout(retryTimer)
      clearInterval(pingInterval)
      ws?.close()
      setInbox([])
    }
  }, [inboxActive])

  // --- platformFetch — always available, zero overhead until called ---
  const platformFetch = useCallback(async (path: string, init?: RequestInit) => {
    const token = await getAuthToken()
    const headers = new Headers(init?.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (!headers.has('Content-Type') && init?.body) headers.set('Content-Type', 'application/json')
    return fetch(`/platform${path}`, { ...init, headers })
  }, [])

  return (
    <PlatformContext.Provider value={{ platformFetch, subscribeInbox, inbox }}>
      {children}
    </PlatformContext.Provider>
  )
}
