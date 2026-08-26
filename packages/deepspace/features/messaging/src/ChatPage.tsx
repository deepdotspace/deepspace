/**
 * ChatPage -- Routable messaging page with header and MessageList.
 * Parent container must have a definite height (h-full / flex-1).
 */

import { useEffect, useRef } from 'react'
import { useChatChannel } from '../components/messaging/hooks/useChatChannel'
import { RecordScope, useReadReceipts, useUser, isWriterRole } from 'deepspace'
import type { CollectionSchema } from 'deepspace/schema'
import { messagingSchemas } from '../schemas/messaging-schema'
import { ChatHeader } from '../components/messaging/chat/ChatHeader'
import { MessageList } from '../components/messaging/chat/MessageList'

interface ChatPageProps {
  schemas?: CollectionSchema[]
  channelName?: string
  className?: string
}

export default function ChatPage({
  schemas = messagingSchemas,
  channelName = 'general',
  className,
}: ChatPageProps) {
  const { channelId, status } = useChatChannel(channelName)
  const { markAsRead } = useReadReceipts()
  const { user } = useUser()
  const lastMarkedRef = useRef<string | null>(null)
  const canTrackReadState = isWriterRole(user?.role)

  useEffect(() => {
    if (!channelId || !canTrackReadState) return
    if (lastMarkedRef.current === channelId) return
    lastMarkedRef.current = channelId
    markAsRead(channelId)
  }, [canTrackReadState, channelId, markAsRead])

  if (status !== 'ready') {
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

  if (!channelId) {
    return (
      <div className={`flex flex-col h-full ${className ?? ''}`} data-testid="chat-page">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-foreground">No public channel exists yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              A member or admin can create the first channel.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex flex-col h-full ${className ?? ''}`} data-testid="chat-page">
      <ChatHeader channelId={channelId} />
      <RecordScope roomId={`chat:${channelId}`} schemas={schemas}>
        <MessageList channelId={channelId} />
      </RecordScope>
    </div>
  )
}
