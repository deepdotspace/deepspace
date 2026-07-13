/**
 * MessageItem -- Single message row with avatar, grouped timestamps,
 * desktop hover toolbar, mobile long-press delegation, thread reply count,
 * presence indicator, and user profile popover.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useUserLookup } from 'deepspace'
import { useUser } from 'deepspace'
import { usePresence } from 'deepspace'
import type { Message } from 'deepspace'
import type { RecordData } from 'deepspace'
import type { GroupedReaction } from 'deepspace'
import { UserProfilePopover } from './UserProfilePopover'
import { useLongPress } from '../hooks/useLongPress'

const QUICK_EMOJIS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F389}', '\u{1F525}', '\u{1F440}']

export interface MessageRect {
  top: number
  left: number
  width: number
  height: number
}

interface MessageItemProps {
  message: RecordData<Message>
  reactions: GroupedReaction[]
  threadCount: number
  onToggleReaction: (emoji: string) => void
  onOpenThread: () => void
  onEdit: (newContent: string) => void
  onDelete: () => void
  isFirstInGroup: boolean
  onLongPress?: (rect: MessageRect) => void
  forceEdit?: boolean
  onEditDone?: () => void
  isHighlighted?: boolean
  onStartDM?: (userId: string) => void
}

export function MessageItem({
  message,
  reactions,
  threadCount,
  onToggleReaction,
  onOpenThread,
  onEdit,
  onDelete,
  isFirstInGroup,
  onLongPress,
  forceEdit = false,
  onEditDone,
  isHighlighted = false,
  onStartDM,
}: MessageItemProps) {
  const { getUser } = useUserLookup()
  const { user: currentUser } = useUser()
  const { isOnline } = usePresence()
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.data.content)
  const editContainerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const authorId = message.data.authorId || message.createdBy
  const author = getUser(authorId)
  const isOwn = currentUser?.id === authorId || currentUser?.id === message.createdBy
  const online = isOnline(authorId)

  const longPressHandlers = useLongPress(
    () => {
      if (!contentRef.current) return
      const rect = contentRef.current.getBoundingClientRect()
      onLongPress?.({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      })
    },
    { delay: 500, threshold: 10 }
  )

  useEffect(() => {
    if (forceEdit && !isEditing) {
      setIsEditing(true)
      setEditContent(message.data.content)
    }
    // Deps intentionally limited to [forceEdit]: this reacts only to the
    // forceEdit trigger. Including isEditing/message.data.content would re-fire
    // on every keystroke and clobber the in-progress edit buffer.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on forceEdit; adding isEditing/message.data.content would re-fire on keystrokes and clobber the edit buffer
  }, [forceEdit])

  const timestamp = new Date(message.createdAt)
  const timeStr = timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const dateTimeStr = timestamp.toLocaleDateString(undefined, {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  }) + ', ' + timeStr

  const exitEdit = useCallback(() => {
    setIsEditing(false)
    onEditDone?.()
  }, [onEditDone])

  const handleSaveEdit = useCallback(() => {
    const trimmed = editContent.trim()
    if (trimmed && trimmed !== message.data.content) {
      onEdit(trimmed)
    }
    exitEdit()
  }, [editContent, message.data.content, onEdit, exitEdit])

  const handleCancelEdit = useCallback(() => {
    setEditContent(message.data.content)
    exitEdit()
  }, [message.data.content, exitEdit])

  useEffect(() => {
    if (!isEditing) return
    function handleClickOutside(e: MouseEvent) {
      if (editContainerRef.current && !editContainerRef.current.contains(e.target as Node)) {
        setEditContent(message.data.content)
        exitEdit()
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isEditing, message.data.content, exitEdit])

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSaveEdit()
    }
    if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  const avatar = (
    <div className="relative">
      {author?.imageUrl ? (
        <img src={author.imageUrl} alt="" className="w-10 h-10 rounded-full" />
      ) : (
        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-sm font-semibold text-primary">
          {(author?.name ?? '?')[0]?.toUpperCase()}
        </div>
      )}
      <span
        className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-background ${
          online ? 'bg-success' : 'bg-muted-foreground/30'
        }`}
      />
    </div>
  )

  // Soft-deleted messages render as a tombstone — the row stays so threads,
  // read-receipts, and parent links remain coherent, but no content/actions.
  if (message.data.deleted) {
    return (
      <div
        data-testid={`message-${message.recordId}`}
        className={`group relative flex gap-4 px-4 py-0.5 select-none ${
          isFirstInGroup ? 'mt-4' : ''
        }`}
      >
        <div className="shrink-0 w-10" />
        <p
          data-testid="deleted-tombstone"
          className="text-sm italic text-muted-foreground/70"
        >
          This message was deleted.
        </p>
      </div>
    )
  }

  return (
    <div
      data-testid={`message-${message.recordId}`}
      className={`group relative flex gap-4 px-4 py-0.5 hover:bg-muted/30 transition-colors select-none ${
        isFirstInGroup ? 'mt-4' : ''
      }`}
      {...longPressHandlers}
    >
      {/* Avatar column */}
      <div className="shrink-0 w-10">
        {isFirstInGroup ? (
          <UserProfilePopover userId={authorId} onStartDM={onStartDM}>
            {avatar}
          </UserProfilePopover>
        ) : (
          <span className="w-full pt-1 flex justify-center text-[10px] text-muted-foreground/0 group-hover:text-muted-foreground/70 transition-colors select-none">
            {timeStr}
          </span>
        )}
      </div>

      {/* Content column */}
      <div
        ref={contentRef}
        className={`flex-1 min-w-0 ${isHighlighted ? 'invisible' : ''}`}
      >
        {isFirstInGroup && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <UserProfilePopover userId={authorId} onStartDM={onStartDM}>
              <span className="text-sm font-semibold text-foreground hover:underline cursor-pointer">
                {author?.name ?? 'Unknown'}
              </span>
            </UserProfilePopover>
            <span className="text-xs text-muted-foreground">{dateTimeStr}</span>
          </div>
        )}

        {isEditing ? (
          <div ref={editContainerRef} className="mt-1" data-testid="edit-container">
            <div className="flex items-end gap-1.5">
              <textarea
                data-testid="edit-message-input"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                onKeyDown={handleEditKeyDown}
                className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground resize-none outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 min-h-[44px]"
                rows={Math.max(2, editContent.split('\n').length)}
                autoFocus
              />
              <div className="flex flex-col gap-1 pb-0.5">
                <button
                  data-testid="save-edit-btn"
                  onClick={handleSaveEdit}
                  className="p-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  title="Save"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </button>
                <button
                  data-testid="cancel-edit-btn"
                  onClick={handleCancelEdit}
                  className="p-1.5 rounded-md bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                  title="Cancel"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words leading-relaxed" data-testid="message-content">
            {message.data.content}
            {message.data.edited ? (
              <span className="text-[10px] ml-1.5 text-muted-foreground italic">(edited)</span>
            ) : null}
          </p>
        )}

        {/* Reactions */}
        {reactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1" data-testid="message-reactions">
            {reactions.map((r) => (
              <button
                key={r.emoji}
                data-testid={`reaction-${message.recordId}-${r.emoji}`}
                onClick={() => onToggleReaction(r.emoji)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors ${
                  r.currentUserReacted
                    ? 'bg-primary/15 border-primary/30 text-primary'
                    : 'bg-accent/60 border-border/40 text-muted-foreground hover:border-primary/25'
                }`}
              >
                <span>{r.emoji}</span>
                <span className="font-medium">{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Thread reply count */}
        {threadCount > 0 ? (
          <button
            data-testid={`thread-count-${message.recordId}`}
            onClick={onOpenThread}
            className="mt-1 text-xs text-primary hover:underline"
          >
            {threadCount} {threadCount === 1 ? 'reply' : 'replies'}
          </button>
        ) : null}
      </div>

      {/* Desktop hover toolbar */}
      {!isEditing && (
        <div data-testid={`hover-toolbar-${message.recordId}`} className="absolute -top-3 right-5 flex items-center gap-0.5 bg-card border border-border/60 rounded-lg shadow-sm p-0.5 transition-all duration-100 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              data-testid={`toolbar-emoji-${emoji}`}
              onClick={() => onToggleReaction(emoji)}
              className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-sm hover:bg-muted transition-colors"
            >
              {emoji}
            </button>
          ))}
          <div className="shrink-0 w-px h-4 bg-border/40 mx-0.5" />
          <button
            data-testid={`reply-btn-${message.recordId}`}
            onClick={onOpenThread}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Reply in thread"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>
          {isOwn && (
            <>
              <button
                data-testid={`edit-btn-${message.recordId}`}
                onClick={() => {
                  setIsEditing(true)
                  setEditContent(message.data.content)
                }}
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="Edit message"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                data-testid={`delete-btn-${message.recordId}`}
                onClick={onDelete}
                className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                title="Delete message"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
