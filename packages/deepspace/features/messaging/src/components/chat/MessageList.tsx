/**
 * MessageList -- Self-contained chat panel (feed + composer + thread panel).
 * Do not render a separate MessageInput alongside this component.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useMessages } from 'deepspace'
import { useReactions } from 'deepspace'
import { useUser } from 'deepspace'
import type { Message } from 'deepspace'
import type { RecordData } from 'deepspace'
import { MessageItem } from './MessageItem'
import type { MessageRect } from './MessageItem'
import { MessageInput } from './MessageInput'
import { MessageActionSheet } from './MessageActionSheet'
import { ThreadPanel } from './ThreadPanel'

interface MessageListProps {
  channelId: string
  onStartDM?: (userId: string) => void
}

interface ActionSheetState {
  messageId: string
  content: string
  isOwn: boolean
  rect: MessageRect
}

const GROUP_THRESHOLD_MS = 5 * 60 * 1000
const TIME_SEPARATOR_GAP_MS = 60 * 60 * 1000

function getAuthorId(msg: RecordData<Message>): string {
  return msg.data.authorId || msg.createdBy
}

function isFirstInGroup(msgs: RecordData<Message>[], i: number): boolean {
  if (i === 0) return true
  const prev = msgs[i - 1]
  const curr = msgs[i]
  if (getAuthorId(prev) !== getAuthorId(curr)) return true
  return new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime() >= GROUP_THRESHOLD_MS
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function getSeparatorLabel(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return `Today ${formatTime(date)}`
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${formatTime(date)}`
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }) + ` ${formatTime(date)}`
}

function shouldShowSeparator(current: RecordData<Message>, prev: RecordData<Message> | undefined): boolean {
  if (!prev) return true
  const curDate = new Date(current.createdAt)
  const prevDate = new Date(prev.createdAt)
  if (curDate.toDateString() !== prevDate.toDateString()) return true
  return curDate.getTime() - prevDate.getTime() >= TIME_SEPARATOR_GAP_MS
}

export function MessageList({ channelId, onStartDM }: MessageListProps) {
  const { messages, status, send, edit, softDelete } = useMessages(channelId)
  const { getReactionsForMessage, toggle: toggleReaction } = useReactions(channelId)
  const { user: currentUser } = useUser()
  const bottomRef = useRef<HTMLDivElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const isInitialMount = useRef(true)
  const prevMessageCount = useRef(0)
  const [actionSheet, setActionSheet] = useState<ActionSheetState | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null)

  const topLevelMessages = useMemo(
    () =>
      messages
        .filter((m: RecordData<Message>) => !m.data.parentMessageId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [messages]
  )

  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of messages) {
      if (m.data.parentMessageId) {
        counts.set(
          m.data.parentMessageId,
          (counts.get(m.data.parentMessageId) ?? 0) + 1
        )
      }
    }
    return counts
  }, [messages])

  useEffect(() => {
    const count = topLevelMessages.length
    const wasNewMessage = count > prevMessageCount.current
    prevMessageCount.current = count

    if (count === 0) return

    if (isInitialMount.current) {
      isInitialMount.current = false
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
      return
    }

    if (!wasNewMessage) return

    const feed = feedRef.current
    if (!feed) return
    const distanceFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight
    const NEAR_BOTTOM_THRESHOLD = 150
    if (distanceFromBottom <= NEAR_BOTTOM_THRESHOLD) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [topLevelMessages.length])

  const handleLongPress = useCallback(
    (msg: RecordData<Message>, rect: MessageRect) => {
      const authorId = msg.data.authorId || msg.createdBy
      const isOwn = currentUser?.id === authorId || currentUser?.id === msg.createdBy
      setActionSheet({
        messageId: msg.recordId,
        content: msg.data.content,
        isOwn,
        rect,
      })
    },
    [currentUser]
  )

  if (status === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading messages...</div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-destructive">
          <p className="text-sm font-medium">Failed to load messages</p>
          <p className="text-xs text-muted-foreground mt-1">Check your connection and try again</p>
        </div>
      </div>
    )
  }

  const threadOpen = !!threadMessageId

  return (
    <div className="flex flex-1 min-h-0">
      <div className={`flex flex-col flex-1 min-w-0 ${threadOpen ? 'hidden md:flex' : 'flex'}`}>
        <div ref={feedRef} className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col" data-testid="messages-feed">
          {topLevelMessages.length === 0 ? (
            <div className="flex items-center justify-center flex-1">
              <div className="text-center text-muted-foreground">
                <p className="text-lg mb-1">No messages yet</p>
                <p className="text-sm">Be the first to send a message!</p>
              </div>
            </div>
          ) : (
            <div className="mt-auto pt-6 pb-4">
              {topLevelMessages.map((msg: RecordData<Message>, i: number) => {
                const prev = i > 0 ? topLevelMessages[i - 1] : undefined
                const showSeparator = shouldShowSeparator(msg, prev)
                const firstInGroup = showSeparator || isFirstInGroup(topLevelMessages, i)

                return (
                  <div key={msg.recordId}>
                    {showSeparator && (
                      <div className="relative flex items-center justify-center my-2 mx-4" data-testid="date-separator">
                        <div className="absolute inset-0 flex items-center">
                          <div className="w-full border-t border-border" />
                        </div>
                        <span className="relative text-[11px] font-medium text-muted-foreground bg-background px-2">
                          {getSeparatorLabel(new Date(msg.createdAt))}
                        </span>
                      </div>
                    )}
                    <MessageItem
                      message={msg}
                      reactions={getReactionsForMessage(msg.recordId)}
                      threadCount={threadCounts.get(msg.recordId) ?? 0}
                      onToggleReaction={(emoji) => toggleReaction(msg.recordId, emoji)}
                      onOpenThread={() => setThreadMessageId(msg.recordId)}
                      onEdit={(newContent) => edit(msg.recordId, newContent)}
                      onDelete={() => softDelete(msg.recordId)}
                      isFirstInGroup={firstInGroup}
                      onLongPress={(rect) => handleLongPress(msg, rect)}
                      forceEdit={editingMessageId === msg.recordId}
                      onEditDone={() => setEditingMessageId(null)}
                      isHighlighted={actionSheet?.messageId === msg.recordId}
                      onStartDM={onStartDM}
                    />
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <MessageInput onSend={(content) => send(content)} placeholder="Type a message..." />
      </div>

      {threadMessageId && (
        <ThreadPanel
          channelId={channelId}
          parentMessageId={threadMessageId}
          onClose={() => setThreadMessageId(null)}
        />
      )}

      <MessageActionSheet
        visible={!!actionSheet}
        onClose={() => setActionSheet(null)}
        isOwn={actionSheet?.isOwn ?? false}
        onReaction={(emoji) => {
          if (actionSheet) toggleReaction(actionSheet.messageId, emoji)
        }}
        onEdit={() => {
          if (actionSheet) setEditingMessageId(actionSheet.messageId)
        }}
        onDelete={() => {
          if (actionSheet) softDelete(actionSheet.messageId)
        }}
        onReply={() => {
          if (actionSheet) setThreadMessageId(actionSheet.messageId)
        }}
        messageContent={actionSheet?.content ?? ''}
        messageRect={actionSheet?.rect ?? null}
      />
    </div>
  )
}
