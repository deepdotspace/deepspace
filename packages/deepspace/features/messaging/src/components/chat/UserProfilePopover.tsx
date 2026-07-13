/**
 * UserProfilePopover -- Click avatar/name to view a lightweight profile card.
 * Positioned below the trigger by default, flips above if insufficient space.
 */

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { useUserLookup } from 'deepspace'
import { useUser } from 'deepspace'
import { usePresence } from 'deepspace'

interface UserProfilePopoverProps {
  userId: string
  children: ReactNode
  onStartDM?: (userId: string) => void
}

function formatLastSeen(lastSeenAt: string | undefined): string {
  if (!lastSeenAt) return 'Never seen'
  const diff = Date.now() - new Date(lastSeenAt).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const POPOVER_HEIGHT_ESTIMATE = 180

export function UserProfilePopover({ userId, children, onStartDM }: UserProfilePopoverProps) {
  const { getUser } = useUserLookup()
  const { user: currentUser } = useUser()
  const { isOnline, users } = usePresence()
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<'below' | 'above'>('below')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const user = getUser(userId)
  const roomUser = users.find((u) => u.id === userId)
  const online = isOnline(userId)

  const close = useCallback(() => setOpen(false), [])

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      if (!prev && triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect()
        const spaceBelow = window.innerHeight - rect.bottom
        const inBottomHalf = rect.top > window.innerHeight / 2
        setPlacement(
          spaceBelow < POPOVER_HEIGHT_ESTIMATE || inBottomHalf ? 'above' : 'below'
        )
      }
      return !prev
    })
  }, [])

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        close()
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open, close])

  const positionClass = placement === 'above'
    ? 'bottom-full mb-2 left-0'
    : 'top-full mt-2 left-0'

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className="cursor-pointer text-left"
      >
        {children}
      </button>

      {open && user && (
        <div
          ref={popoverRef}
          data-testid="user-profile-popover"
          className={`absolute ${positionClass} z-50 w-60 bg-card border border-border rounded-lg shadow-lg p-4 animate-in fade-in zoom-in-95 duration-150`}
        >
          <div className="flex items-start gap-3">
            <div className="relative shrink-0">
              {user.imageUrl ? (
                <img src={user.imageUrl} alt="" className="w-12 h-12 rounded-full" />
              ) : (
                <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center text-base font-semibold text-primary">
                  {(user.name ?? '?')[0]?.toUpperCase()}
                </div>
              )}
              <span
                className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-card ${
                  online ? 'bg-success' : 'bg-muted-foreground/30'
                }`}
              />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">{user.name ?? 'Unknown'}</p>
              {roomUser?.role && (
                <span className="inline-block mt-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-muted text-muted-foreground">
                  {roomUser.role}
                </span>
              )}
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-border space-y-1.5">
            {roomUser?.email && (
              <p className="text-xs text-muted-foreground truncate">{roomUser.email}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {online ? 'Online' : `Last seen ${formatLastSeen(roomUser?.lastSeenAt)}`}
            </p>
          </div>

          {onStartDM && currentUser?.id !== userId && (
            <button
              data-testid={`dm-from-profile-${userId}`}
              onClick={() => {
                onStartDM(userId)
                close()
              }}
              className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Message
            </button>
          )}
        </div>
      )}
    </span>
  )
}
