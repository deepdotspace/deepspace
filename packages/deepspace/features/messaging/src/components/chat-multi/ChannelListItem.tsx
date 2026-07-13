/**
 * ChannelListItem -- Single conversation row in the channel sidebar.
 *
 * Visual treatment varies by type:
 *   - Groups: colored icon badge with group/lock icon
 *   - DMs: user avatar with online presence ring
 *
 * Active state uses a left accent bar + tinted background.
 * Unread state uses bold text + pulsing dot indicator.
 */

import type { ReactNode } from 'react'

interface ChannelListItemProps {
  name: string
  isActive: boolean
  hasUnread: boolean
  isPrivate?: boolean
  avatarUrl?: string
  avatarFallback?: string
  isOnline?: boolean
  onClick: () => void
  trailing?: ReactNode
}

const GROUP_COLORS = [
  'from-primary/20 to-primary/10 text-primary',
  'from-primary/15 to-primary/25 text-primary',
  'from-primary/10 to-primary/20 text-primary',
  'from-primary/25 to-primary/15 text-primary',
  'from-primary/20 to-primary/5 text-primary',
  'from-primary/5 to-primary/20 text-primary',
]

function hashToIndex(str: string, max: number): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return Math.abs(hash) % max
}

export function ChannelListItem({
  name,
  isActive,
  hasUnread,
  isPrivate,
  avatarUrl,
  avatarFallback,
  isOnline,
  onClick,
  trailing,
}: ChannelListItemProps) {
  const showAvatar = avatarUrl !== undefined || avatarFallback !== undefined
  const colorIdx = hashToIndex(name, GROUP_COLORS.length)

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`channel-link-${name}`}
      className={`
        group/item relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl
        text-left transition-all duration-200 cursor-pointer
        ${isActive
          ? 'bg-primary/8 shadow-sm shadow-primary/5'
          : 'hover:bg-muted/50 active:bg-muted/70'
        }
      `}
    >
      {/* Active indicator bar */}
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-primary" />
      )}

      {/* Avatar / icon */}
      {showAvatar ? (
        <div className="relative shrink-0">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className={`w-9 h-9 rounded-full object-cover ring-2 transition-all duration-200 ${
                isActive
                  ? 'ring-primary/20'
                  : 'ring-transparent group-hover/item:ring-muted'
              }`}
            />
          ) : (
            <div
              className={`w-9 h-9 rounded-full bg-gradient-to-br ${GROUP_COLORS[colorIdx]} flex items-center justify-center text-sm font-semibold ring-2 transition-all duration-200 ${
                isActive
                  ? 'ring-primary/20'
                  : 'ring-transparent group-hover/item:ring-muted'
              }`}
            >
              {avatarFallback?.[0]?.toUpperCase() ?? '?'}
            </div>
          )}
          {isOnline !== undefined && (
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-[2.5px] border-card transition-colors duration-200 ${
                isOnline ? 'bg-success' : 'bg-muted-foreground/20'
              }`}
            />
          )}
        </div>
      ) : (
        <span
          className={`shrink-0 w-9 h-9 rounded-xl bg-gradient-to-br ${GROUP_COLORS[colorIdx]} flex items-center justify-center transition-all duration-200`}
        >
          {isPrivate ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )}
        </span>
      )}

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <span
          className={`block text-[13px] leading-tight truncate transition-colors duration-150 ${
            isActive
              ? 'font-semibold text-foreground'
              : hasUnread
                ? 'font-semibold text-foreground'
                : 'font-medium text-muted-foreground group-hover/item:text-foreground'
          }`}
        >
          {name}
        </span>
      </div>

      {/* Unread dot */}
      {hasUnread && !isActive && (
        <span className="shrink-0 w-2.5 h-2.5 rounded-full bg-primary animate-pulse" />
      )}

      {trailing}
    </button>
  )
}
