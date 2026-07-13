/**
 * ChatPage -- Routable messaging page with header and MessageList.
 * Parent container must have a definite height (h-full / flex-1).
 */

import { useEffect, useRef } from 'react'
import { useChatChannel } from '../components/messaging/hooks/useChatChannel'
import { useReadReceipts } from 'deepspace'
import { RecordScope } from 'deepspace'
import type { CollectionSchema } from 'deepspace/worker'
import { messagingSchemas } from '../schemas/messaging-schema'
import { ChatHeader } from '../components/messaging/chat/ChatHeader'
import { MessageList } from '../components/messaging/chat/MessageList'

interface ChatPageProps {
  schemas?: CollectionSchema[]
  appId?: string
  channelName?: string
  className?: string
}

export default function ChatPage({
  schemas = messagingSchemas,
  appId = '',
  channelName = 'general',
  className,
}: ChatPageProps) {
  const { channelId, status, isMember, join } = useChatChannel(channelName)
  const { markAsRead } = useReadReceipts()
  const lastMarkedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!channelId || !isMember) return
    if (lastMarkedRef.current === channelId) return
    lastMarkedRef.current = channelId
    markAsRead(channelId)
  }, [channelId, isMember, markAsRead])

  if (status !== 'ready' || !channelId) {
    // data-testid lets tests (and humans reading a trace) distinguish "stuck
    // waiting for the default channel" from "route never mounted".
    return (
      <div
        data-testid="chat-page-loading"
        className={`flex items-center justify-center h-full ${className ?? ''}`}
      >
        <div className="text-muted-foreground text-sm">Loading chat...</div>
      </div>
    )
  }

  if (!isMember) {
    return (
      <div className={`flex flex-col h-full ${className ?? ''}`} data-testid="chat-page">
        <ChatHeader channelId={channelId} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-foreground mb-3">You're not a member of this channel</p>
            <button
              data-testid="join-channel-btn"
              onClick={join}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              Join Channel
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex flex-col h-full ${className ?? ''}`} data-testid="chat-page">
      <ChatHeader channelId={channelId} />
      <RecordScope roomId={`chat:${channelId}`} schemas={schemas} appId={appId}>
        <MessageList channelId={channelId} />
      </RecordScope>
    </div>
  )
}
