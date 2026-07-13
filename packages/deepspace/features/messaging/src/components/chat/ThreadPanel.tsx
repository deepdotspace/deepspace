/**
 * ThreadPanel -- Side panel for threaded replies on a parent message.
 * Renders the parent message preview, a scrollable reply list, and a composer.
 */

import { useEffect, useRef } from 'react'
import { useMessages } from 'deepspace'
import { useReactions } from 'deepspace'
import { useUserLookup } from 'deepspace'
import type { Message } from 'deepspace'
import type { RecordData } from 'deepspace'
import { MessageItem } from './MessageItem'
import { MessageInput } from './MessageInput'

interface ThreadPanelProps {
  channelId: string
  parentMessageId: string
  onClose: () => void
}

export function ThreadPanel({ channelId, parentMessageId, onClose }: ThreadPanelProps) {
  const { messages: allMessages } = useMessages(channelId)
  const { messages: replies, send, edit, remove } = useMessages(channelId, {
    parentMessageId,
  })
  const { getReactionsForMessage, toggle: toggleReaction } = useReactions(channelId)
  const { getUser } = useUserLookup()
  const bottomRef = useRef<HTMLDivElement>(null)

  const parentMessage = allMessages.find(
    (m: RecordData<Message>) => m.recordId === parentMessageId
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [replies.length])

  const parentAuthor = parentMessage
    ? getUser(parentMessage.data.authorId || parentMessage.createdBy)
    : null

  const parentTime = parentMessage
    ? new Date(parentMessage.createdAt).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''

  return (
    <div
      data-testid="thread-panel"
      className="w-full md:w-80 md:border-l border-border flex flex-col h-full bg-card md:shrink-0"
    >
      <div className="shrink-0 h-12 border-b border-border px-4 flex items-center justify-between">
        <h3 className="font-semibold text-sm text-foreground">Thread</h3>
        <button
          data-testid="close-thread-btn"
          onClick={onClose}
          className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {parentMessage && (
        <div className="shrink-0 px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-baseline gap-2 mb-1">
            <span className="font-semibold text-sm text-foreground">
              {parentAuthor?.name ?? 'Unknown'}
            </span>
            <span className="text-xs text-muted-foreground">{parentTime}</span>
          </div>
          <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words" data-testid="thread-parent-content">
            {parentMessage.data.content}
          </p>
          <div className="mt-1.5 text-xs text-muted-foreground">
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto" data-testid="thread-replies">
        {replies.map((msg: RecordData<Message>) => (
          <MessageItem
            key={msg.recordId}
            message={msg}
            reactions={getReactionsForMessage(msg.recordId)}
            threadCount={0}
            onToggleReaction={(emoji) => toggleReaction(msg.recordId, emoji)}
            onOpenThread={() => {}}
            onEdit={(newContent) => edit(msg.recordId, newContent)}
            onDelete={() => remove(msg.recordId)}
            isFirstInGroup
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <MessageInput
        onSend={(content) => send(content, parentMessageId)}
        placeholder="Reply..."
      />
    </div>
  )
}
