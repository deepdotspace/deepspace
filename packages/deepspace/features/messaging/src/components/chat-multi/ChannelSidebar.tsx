/**
 * ChannelSidebar -- Multi-channel navigation panel.
 *
 * Design language:
 *   - Collapsible sections with smooth expand/collapse
 *   - Gradient-accented group icons, presence-aware DM avatars
 *   - Quick-filter search that narrows both groups and DMs
 *   - Glassmorphic header with user profile in footer
 *   - Subtle section dividers with label badges
 *
 * On mobile, this is a full-screen view; on desktop, a fixed-width left panel.
 * Sidebar scrollbar CSS is injected via a <style> tag.
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import { useUser } from 'deepspace'
import { usePresence } from 'deepspace'
import type { Channel, ChannelInvitation } from 'deepspace'
import type { RecordData } from 'deepspace'
import { ChannelListItem } from './ChannelListItem'
import { CreateGroupModal } from './CreateGroupModal'
import { NewMessageModal } from './NewMessageModal'
import { BrowseGroupsModal } from './BrowseGroupsModal'
import { InvitationList } from './InvitationList'

const SIDEBAR_STYLES_ID = 'deepspace-sidebar-styles'
const SIDEBAR_CSS = `/* Channel sidebar smooth transitions */
[data-testid="channel-sidebar"] {
  transition: transform 200ms ease-out;
}
/* Scrollbar styling for sidebar */
.channel-sidebar-scroll::-webkit-scrollbar {
  width: 5px;
}
.channel-sidebar-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.channel-sidebar-scroll::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
  transition: background 200ms;
}
.channel-sidebar-scroll:hover::-webkit-scrollbar-thumb {
  background: var(--border);
}
.channel-sidebar-scroll:hover::-webkit-scrollbar-thumb:hover {
  background: var(--muted-foreground);
}
/* Firefox scrollbar */
.channel-sidebar-scroll {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
.channel-sidebar-scroll:hover {
  scrollbar-color: var(--border) transparent;
}
/* Respect reduced motion */
@media (prefers-reduced-motion: reduce) {
  [data-testid="channel-sidebar"],
  [data-testid="channel-sidebar"] * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}`

interface PendingInvitation {
  invitation: RecordData<ChannelInvitation>
  channel: RecordData<Channel> | undefined
}

interface ChannelSidebarProps {
  groups: RecordData<Channel>[]
  dms: RecordData<Channel>[]
  pendingInvitations: PendingInvitation[]
  activeChannelId: string | null
  onSelectChannel: (id: string) => void
  hasUnread: (id: string) => boolean
  getDMDisplayName: (channel: RecordData<Channel>) => string
}

export function ChannelSidebar({
  groups,
  dms,
  pendingInvitations,
  activeChannelId,
  onSelectChannel,
  hasUnread,
  getDMDisplayName,
}: ChannelSidebarProps) {
  const { user } = useUser()
  const { isOnline, users } = usePresence()
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [showNewMessage, setShowNewMessage] = useState(false)
  const [showBrowse, setShowBrowse] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [groupsCollapsed, setGroupsCollapsed] = useState(false)
  const [dmsCollapsed, setDmsCollapsed] = useState(false)

  // Inject sidebar CSS once
  useEffect(() => {
    if (document.getElementById(SIDEBAR_STYLES_ID)) return
    const style = document.createElement('style')
    style.id = SIDEBAR_STYLES_ID
    style.textContent = SIDEBAR_CSS
    document.head.appendChild(style)
  }, [])

  const normalizedQuery = filterQuery.toLowerCase().trim()

  const sortedGroups = useMemo(
    () =>
      [...groups]
        .filter((g) => !normalizedQuery || g.data.name.toLowerCase().includes(normalizedQuery))
        .sort((a, b) => a.data.name.localeCompare(b.data.name)),
    [groups, normalizedQuery]
  )

  const sortedDMs = useMemo(
    () =>
      [...dms]
        .filter((d) => {
          if (!normalizedQuery) return true
          return getDMDisplayName(d).toLowerCase().includes(normalizedQuery)
        })
        .sort((a, b) => getDMDisplayName(a).localeCompare(getDMDisplayName(b))),
    [dms, getDMDisplayName, normalizedQuery]
  )

  const getDMOtherUserId = useCallback(
    (channel: RecordData<Channel>): string | undefined => {
      if (!user) return undefined
      const parts = channel.data.name.replace('dm-', '').split('-')
      return parts.find((id) => id !== user.id)
    },
    [user]
  )

  const getDMAvatarInfo = useCallback(
    (channel: RecordData<Channel>) => {
      const otherId = getDMOtherUserId(channel)
      if (!otherId) return { url: undefined, fallback: '?', online: false }
      const otherUser = users.find((u) => u.id === otherId)
      return {
        url: otherUser?.imageUrl,
        fallback: otherUser?.name ?? '?',
        online: isOnline(otherId),
      }
    },
    [getDMOtherUserId, users, isOnline]
  )

  const totalUnreadGroups = groups.filter((g) => hasUnread(g.recordId)).length
  const totalUnreadDMs = dms.filter((d) => hasUnread(d.recordId)).length

  return (
    <>
      <aside
        data-testid="channel-sidebar"
        className="flex flex-col h-full bg-card/95 backdrop-blur-sm"
      >
        {/* Header */}
        <div className="shrink-0 px-4 pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-foreground tracking-tight">Messages</h2>
            <button
              data-testid="new-message-btn"
              onClick={() => setShowNewMessage(true)}
              className="p-2 rounded-xl bg-primary/10 text-primary hover:bg-primary/20 active:bg-primary/25 transition-colors duration-200 cursor-pointer"
              title="New message"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          </div>

          {/* Search / filter */}
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              data-testid="sidebar-search"
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Search conversations..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-muted/40 border border-border/50 rounded-xl text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/40 focus:bg-muted/60 focus:ring-1 focus:ring-primary/10 transition-all duration-200"
            />
            {filterQuery && (
              <button
                onClick={() => setFilterQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Scrollable channel lists */}
        <div className="flex-1 overflow-y-auto px-2.5 pb-2 channel-sidebar-scroll">
          {/* Pending invitations */}
          <InvitationList
            invitations={pendingInvitations}
            onAccepted={(channelId) => onSelectChannel(channelId)}
          />

          {/* Groups section */}
          <SidebarSection
            label="Groups"
            count={sortedGroups.length}
            unreadCount={totalUnreadGroups}
            collapsed={groupsCollapsed}
            onToggle={() => setGroupsCollapsed((c) => !c)}
            onAction={() => setShowCreateGroup(true)}
            actionTitle="Create group"
            actionTestId="create-group-btn"
          >
            {sortedGroups.length === 0 ? (
              <EmptyState
                message={normalizedQuery ? 'No groups match your search' : 'No groups yet'}
                actionLabel={normalizedQuery ? undefined : 'Create one'}
                onAction={normalizedQuery ? undefined : () => setShowCreateGroup(true)}
              />
            ) : (
              <div className="space-y-0.5">
                {sortedGroups.map((ch: RecordData<Channel>) => (
                  <ChannelListItem
                    key={ch.recordId}
                    name={ch.data.name}
                    isActive={activeChannelId === ch.recordId}
                    hasUnread={hasUnread(ch.recordId)}
                    isPrivate={ch.data.type === 'private'}
                    onClick={() => onSelectChannel(ch.recordId)}
                  />
                ))}
              </div>
            )}

            {/* Browse public groups */}
            {!normalizedQuery && (
              <button
                data-testid="browse-groups-btn"
                onClick={() => setShowBrowse(true)}
                className="flex items-center gap-2 w-full px-3 py-2 mt-1 text-[13px] text-muted-foreground/70 hover:text-foreground hover:bg-muted/40 rounded-xl transition-all duration-200 cursor-pointer"
              >
                <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                </svg>
                <span>Browse public groups</span>
              </button>
            )}
          </SidebarSection>

          {/* DMs section */}
          <SidebarSection
            label="Direct Messages"
            count={sortedDMs.length}
            unreadCount={totalUnreadDMs}
            collapsed={dmsCollapsed}
            onToggle={() => setDmsCollapsed((c) => !c)}
            onAction={() => setShowNewMessage(true)}
            actionTitle="New message"
          >
            {sortedDMs.length === 0 ? (
              <EmptyState
                message={normalizedQuery ? 'No messages match your search' : 'No messages yet'}
                actionLabel={normalizedQuery ? undefined : 'Start a conversation'}
                onAction={normalizedQuery ? undefined : () => setShowNewMessage(true)}
              />
            ) : (
              <div className="space-y-0.5">
                {sortedDMs.map((ch: RecordData<Channel>) => {
                  const avatar = getDMAvatarInfo(ch)
                  return (
                    <ChannelListItem
                      key={ch.recordId}
                      name={getDMDisplayName(ch)}
                      isActive={activeChannelId === ch.recordId}
                      hasUnread={hasUnread(ch.recordId)}
                      avatarUrl={avatar.url}
                      avatarFallback={avatar.fallback}
                      isOnline={avatar.online}
                      onClick={() => onSelectChannel(ch.recordId)}
                    />
                  )
                })}
              </div>
            )}
          </SidebarSection>
        </div>

        {/* Current user footer */}
        {user && (
          <div className="shrink-0 px-3 py-3 border-t border-border/50 bg-card/80 backdrop-blur-sm">
            <div className="flex items-center gap-3 px-1">
              <div className="relative shrink-0">
                {user.imageUrl ? (
                  <img
                    src={user.imageUrl}
                    alt=""
                    className="w-9 h-9 rounded-full object-cover ring-2 ring-success/20"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-sm font-semibold text-primary ring-2 ring-primary/10">
                    {user.name?.[0]?.toUpperCase() ?? '?'}
                  </div>
                )}
                <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-success border-[2.5px] border-card" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{user.name}</p>
                <p className="text-[11px] text-success font-medium">Online</p>
              </div>
            </div>
          </div>
        )}
      </aside>

      {showCreateGroup && (
        <CreateGroupModal
          onClose={() => setShowCreateGroup(false)}
          onCreated={(id) => onSelectChannel(id)}
        />
      )}
      {showNewMessage && (
        <NewMessageModal
          onClose={() => setShowNewMessage(false)}
          onSelected={(id) => onSelectChannel(id)}
        />
      )}
      {showBrowse && (
        <BrowseGroupsModal
          onClose={() => setShowBrowse(false)}
          onSelected={(id) => {
            onSelectChannel(id)
            setShowBrowse(false)
          }}
        />
      )}
    </>
  )
}

/**
 * Collapsible section container with label, count badge, and action button.
 */
function SidebarSection({
  label,
  count,
  unreadCount,
  collapsed,
  onToggle,
  onAction,
  actionTitle,
  actionTestId,
  children,
}: {
  label: string
  count: number
  unreadCount: number
  collapsed: boolean
  onToggle: () => void
  onAction: () => void
  actionTitle: string
  actionTestId?: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-1">
      {/* Section header */}
      <div className="flex items-center gap-1 px-1 py-2">
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer group/section"
        >
          <svg
            className={`w-3 h-3 text-muted-foreground/50 transition-transform duration-200 ${
              collapsed ? '-rotate-90' : 'rotate-0'
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
          <span className="text-[11px] font-bold text-muted-foreground/70 uppercase tracking-widest group-hover/section:text-muted-foreground transition-colors duration-150">
            {label}
          </span>
          {count > 0 && (
            <span className="text-[10px] font-medium text-muted-foreground/40 tabular-nums">
              {count}
            </span>
          )}
          {unreadCount > 0 && (
            <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary/15 text-primary text-[10px] font-bold tabular-nums">
              {unreadCount}
            </span>
          )}
        </button>
        <button
          data-testid={actionTestId}
          onClick={onAction}
          className="p-1 rounded-lg text-muted-foreground/40 hover:text-foreground hover:bg-muted/50 transition-all duration-200 cursor-pointer"
          title={actionTitle}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* Collapsible body */}
      <div
        className={`overflow-hidden transition-all duration-200 ease-out ${
          collapsed ? 'max-h-0 opacity-0' : 'max-h-[2000px] opacity-100'
        }`}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * Friendly empty state with optional CTA.
 */
function EmptyState({
  message,
  actionLabel,
  onAction,
}: {
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="px-3 py-4 text-center">
      <p className="text-[12px] text-muted-foreground/60">{message}</p>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-1.5 text-[12px] font-medium text-primary hover:text-primary/80 transition-colors cursor-pointer"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
