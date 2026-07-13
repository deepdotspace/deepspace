/**
 * MessageActionSheet -- Mobile long-press context menu.
 * Dims the screen, highlights the message in-place, and shows
 * an action bar with edit/delete + emoji reactions.
 */

import { useEffect, useCallback, useState } from 'react'
import { EMOJI_LIST } from './ReactionPicker'
import type { MessageRect } from './MessageItem'

interface MessageActionSheetProps {
  visible: boolean
  onClose: () => void
  isOwn: boolean
  onReaction: (emoji: string) => void
  onEdit: () => void
  onDelete: () => void
  onReply: () => void
  messageContent: string
  messageRect: MessageRect | null
}

const ACTION_BAR_HEIGHT = 44
const VIEWPORT_PADDING = 12

export function MessageActionSheet({
  visible,
  onClose,
  isOwn,
  onReaction,
  onEdit,
  onDelete,
  onReply,
  messageContent,
  messageRect,
}: MessageActionSheetProps) {
  const [layout, setLayout] = useState<'above' | 'below'>('above')

  const handleAction = useCallback(
    (action: () => void) => {
      action()
      onClose()
    },
    [onClose]
  )

  useEffect(() => {
    if (!visible || !messageRect) return
    const spaceAbove = messageRect.top
    const needed = ACTION_BAR_HEIGHT + VIEWPORT_PADDING
    setLayout(spaceAbove >= needed ? 'above' : 'below')
  }, [visible, messageRect])

  useEffect(() => {
    if (!visible) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [visible, onClose])

  if (!visible || !messageRect) return null

  const actionBar = (
    <div
      data-testid="context-action-bar"
      data-context-bar
      className="flex items-center gap-0.5 bg-card border border-border rounded-xl shadow-lg px-1 py-1 overflow-x-auto"
      style={{
        scrollbarWidth: 'none',
        width: messageRect.width,
      }}
    >
      {isOwn && (
        <>
          <button
            data-testid="action-sheet-edit"
            onClick={() => handleAction(onEdit)}
            className="shrink-0 p-1.5 rounded-lg active:bg-muted text-muted-foreground active:text-foreground transition-colors"
            title="Edit"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button
            data-testid="action-sheet-delete"
            onClick={() => handleAction(onDelete)}
            className="shrink-0 p-1.5 rounded-lg active:bg-destructive/10 text-muted-foreground active:text-destructive transition-colors"
            title="Delete"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
          <div className="shrink-0 w-px h-6 bg-border mx-0.5" />
        </>
      )}
      <button
        data-testid="action-sheet-reply"
        onClick={() => handleAction(onReply)}
        className="shrink-0 p-1.5 rounded-lg active:bg-muted text-muted-foreground active:text-foreground transition-colors"
        title="Reply"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
        </svg>
      </button>
      <div className="shrink-0 w-px h-6 bg-border mx-0.5" />
      {EMOJI_LIST.map((emoji) => (
        <button
          key={emoji}
          data-testid={`context-emoji-${emoji}`}
          onClick={() => handleAction(() => onReaction(emoji))}
          className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-base active:scale-110 active:bg-muted transition-all"
        >
          {emoji}
        </button>
      ))}
    </div>
  )

  return (
    <div
      data-testid="message-action-sheet-backdrop"
      className="fixed inset-0 z-[9999]"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 animate-in fade-in duration-150" />

      <div
        className="absolute animate-in fade-in zoom-in-95 duration-150"
        style={{
          top: messageRect.top,
          left: messageRect.left,
          width: messageRect.width,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {layout === 'above' && (
          <div className="absolute bottom-full mb-2 left-0 w-full">
            {actionBar}
          </div>
        )}

        <div
          data-testid="highlighted-message"
          className="bg-card rounded-lg shadow-xl border border-border px-4 py-2.5"
        >
          <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words leading-relaxed">
            {messageContent}
          </p>
        </div>

        {layout === 'below' && (
          <div className="mt-2 w-full">
            {actionBar}
          </div>
        )}
      </div>
    </div>
  )
}
