/**
 * ChatMultiPage -- Full-featured messaging page with sidebar navigation.
 *
 * Layout:
 *   Desktop: [Sidebar 280px] | [Chat Area flex-1] | [Settings/Thread Panel]
 *   Mobile:  Sidebar (full) or Chat (full) -- only one visible at a time.
 *
 * Reuses MessageList from the same messaging feature.
 * Parent container must have a definite height (h-full / flex-1).
 */

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useMultiChannel } from '../components/messaging/hooks/useMultiChannel'
import { useUser } from 'deepspace'
import { useChannelMembers } from 'deepspace'
import { useChannels } from 'deepspace'
import { useReadReceipts } from 'deepspace'
import { useMutations } from 'deepspace'
import { RecordScope } from 'deepspace'
import type { Channel, ChannelMember } from 'deepspace'
import type { RecordData } from 'deepspace'
import type { CollectionSchema } from 'deepspace/worker'
import { messagingSchemas } from '../schemas/messaging-schema'
import { ChannelSidebar } from '../components/messaging/chat-multi/ChannelSidebar'
import { MessageList } from '../components/messaging/chat/MessageList'
import { ChannelSettingsPanel } from '../components/messaging/chat-multi/ChannelSettingsPanel'

interface ChatMultiPageProps {
  schemas?: CollectionSchema[]
  appId?: string
  className?: string
}

export default function ChatMultiPage({
  schemas = messagingSchemas,
  appId = '',
  className,
}: ChatMultiPageProps) {
  const {
    activeChannelId,
    selectChannel,
    channels,
    groups,
    dms,
    pendingInvitations,
    status,
    hasUnread,
    getDMDisplayName,
  } = useMultiChannel()

  const { user } = useUser()
  const { channels: allChannels, create: createChannel } = useChannels()
  const { create: createMembership } = useMutations<ChannelMember>('channel-members')
  const { isMember, join, status: memberStatus } = useChannelMembers(activeChannelId ?? undefined)
  const { markAsRead } = useReadReceipts()

  const [showSettings, setShowSettings] = useState(false)
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar')
  const lastMarkedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeChannelId || !isMember) return
    if (lastMarkedRef.current === activeChannelId) return
    lastMarkedRef.current = activeChannelId
    markAsRead(activeChannelId)
  }, [activeChannelId, isMember, markAsRead])

  const handleSelectChannel = useCallback(
    (channelId: string) => {
      selectChannel(channelId)
      setShowSettings(false)
      setMobileView('chat')
    },
    [selectChannel]
  )

  const handleBack = useCallback(() => {
    setMobileView('sidebar')
    setShowSettings(false)
  }, [])

  const handleLeave = useCallback(() => {
    setShowSettings(false)
    setMobileView('sidebar')
  }, [])

  const handleStartDM = useCallback(
    async (targetUserId: string) => {
      if (!user) return
      const ids = [user.id, targetUserId].sort()
      const dmChannelName = `dm-${ids[0]}-${ids[1]}`

      const existingDM = allChannels.find(
        (c: RecordData<Channel>) => c.data.type === 'dm' && c.data.name === dmChannelName
      )

      if (existingDM) {
        handleSelectChannel(existingDM.recordId)
        return
      }

      const channelId = await createChannel({
        name: dmChannelName,
        type: 'dm',
        description: '',
      })
      if (channelId && user) {
        await createMembership({
          channelId,
          userId: user.id,
          joinedAt: new Date().toISOString(),
        } as unknown as ChannelMember)
        handleSelectChannel(channelId)
      }
    },
    [user, allChannels, createChannel, createMembership, handleSelectChannel]
  )

  const activeChannelData = channels.find(
    (c: RecordData<Channel>) => c.recordId === activeChannelId
  )
  const isDM = activeChannelData?.data.type === 'dm'
  const isPrivate = activeChannelData?.data.type === 'private'

  if (status !== 'ready') {
    return (
      <div className={`flex items-center justify-center h-full ${className ?? ''}`}>
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    )
  }

  return (
    <div className={`flex h-full ${className ?? ''}`} data-testid="chat-multi-page">
      {/* Sidebar -- visible on desktop always; on mobile only when mobileView='sidebar' */}
      <div
        className={`w-full md:w-72 lg:w-80 shrink-0 border-r border-border/40 ${
          mobileView === 'sidebar' ? 'flex' : 'hidden md:flex'
        }`}
      >
        <div className="w-full">
          <ChannelSidebar
            groups={groups}
            dms={dms}
            pendingInvitations={pendingInvitations}
            activeChannelId={activeChannelId}
            onSelectChannel={handleSelectChannel}
            hasUnread={hasUnread}
            getDMDisplayName={getDMDisplayName}
          />
        </div>
      </div>

      {/* Chat area -- on mobile only when mobileView='chat' */}
      <div
        className={`flex-1 flex flex-col min-w-0 ${
          mobileView === 'chat' ? 'flex' : 'hidden md:flex'
        }`}
      >
        {activeChannelId ? (
          <RecordScope key={activeChannelId} roomId={`chat:${activeChannelId}`} schemas={schemas} appId={appId}>
            {/* Multi-channel header with back button on mobile */}
            <div
              data-testid="multi-chat-header"
              className="shrink-0 px-4 py-3 border-b border-border bg-card/80 backdrop-blur-sm flex items-center gap-3"
            >
              {/* Mobile back button */}
              <button
                data-testid="back-to-sidebar"
                onClick={handleBack}
                className="md:hidden p-1 -ml-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>

              <div className="flex-1 min-w-0">
                <h1 className="text-base font-semibold text-foreground truncate">
                  {isDM && activeChannelData
                    ? getDMDisplayName(activeChannelData)
                    : activeChannelData?.data.name ?? 'Chat'}
                </h1>
                {activeChannelData?.data.description && !isDM && (
                  <p className="text-xs text-muted-foreground truncate">
                    {activeChannelData.data.description}
                  </p>
                )}
              </div>

              {/* Settings button for groups (not DMs) */}
              {!isDM && isMember && (
                <button
                  data-testid="toggle-settings-btn"
                  onClick={() => setShowSettings((prev) => !prev)}
                  className={`p-1.5 rounded-md transition-colors ${
                    showSettings
                      ? 'text-primary bg-primary/10'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                  title="Group settings"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              )}
            </div>

            {/* Channel content */}
            {memberStatus === 'ready' && !isMember ? (
              isDM ? (
                <DmAutoJoin join={join} channelId={activeChannelId}>
                  <div className="flex flex-1 min-h-0">
                    <div className={`flex flex-col flex-1 min-w-0 ${showSettings ? 'hidden md:flex' : 'flex'}`}>
                      <MessageList channelId={activeChannelId} onStartDM={handleStartDM} />
                    </div>
                  </div>
                </DmAutoJoin>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    {isPrivate ? (
                      <>
                        <p className="text-foreground mb-1">This is a private group</p>
                        <p className="text-sm text-muted-foreground">
                          You need an invitation to join.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-foreground mb-3">You're not a member of this group</p>
                        <button
                          data-testid="join-channel-btn"
                          onClick={join}
                          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                        >
                          Join Group
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            ) : (
              <div className="flex flex-1 min-h-0">
                <div className={`flex flex-col flex-1 min-w-0 ${showSettings ? 'hidden md:flex' : 'flex'}`}>
                  <MessageList channelId={activeChannelId} onStartDM={handleStartDM} />
                </div>
                {showSettings && activeChannelId && (
                  <ChannelSettingsPanel
                    channelId={activeChannelId}
                    onClose={() => setShowSettings(false)}
                    onLeave={handleLeave}
                  />
                )}
              </div>
            )}
          </RecordScope>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <div className="w-16 h-16 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-muted-foreground/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <p className="text-base font-medium mb-1">Select a conversation</p>
              <p className="text-sm">Choose a group or message from the sidebar</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Auto-joins the current user to a DM channel and renders children immediately.
 * DMs don't require an explicit join gate -- if you can see the DM, you belong in it.
 */
function DmAutoJoin({
  join,
  channelId,
  children,
}: {
  join: () => void
  channelId: string
  children: ReactNode
}) {
  const joined = useRef<string | null>(null)

  useEffect(() => {
    if (joined.current === channelId) return
    joined.current = channelId
    join()
  }, [channelId, join])

  return <>{children}</>
}
