/** MessageInput -- Auto-resizing chat composer. Enter sends, Shift+Enter newlines. */

import { useState, useRef, useCallback } from 'react'

interface MessageInputProps {
  onSend: (content: string) => void
  placeholder?: string
}

export function MessageInput({ onSend, placeholder = 'Type a message...' }: MessageInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSend(trimmed)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, onSend])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  return (
    <div className="px-4 py-3 bg-background" data-testid="message-input-container">
      <div className="flex items-end gap-2 bg-muted/50 border border-border rounded-lg focus-within:border-primary/40 transition-colors">
        <textarea
          ref={textareaRef}
          data-testid="message-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={placeholder}
          rows={1}
          className="flex-1 bg-transparent px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none max-h-40"
        />
        <button
          data-testid="send-message-btn"
          onClick={handleSend}
          disabled={!value.trim()}
          className="shrink-0 px-3 py-2 mr-1 mb-0.5 rounded-md flex items-center justify-center text-muted-foreground disabled:opacity-30 disabled:cursor-not-allowed hover:text-foreground transition-colors"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
