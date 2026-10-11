/**
 * The context menu in the browser: a menu at the pointer on secondary click,
 * closed by a choice, Escape, a click elsewhere, scrolling, or leaving the
 * window. Rendered into `document.body`, so no container clips it. While open
 * it takes the keyboard (a modal shortcut layer), so Escape closes it and the
 * screen's shortcuts wait, as they do under a native menu.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { View } from 'react-native'
import type { ContextMenuItem, ContextMenuProps } from './context-menu-types'
import { useKeyboardShortcuts } from './use-keyboard-shortcuts'

const MENU_WIDTH = 184
const ROW_HEIGHT = 30

export function ContextMenu({ items, enabled = true, onSelect, style, children }: ContextMenuProps): ReactElement {
  // React Native Web renders View as a DOM element; the listener goes on it directly.
  const host = useRef<HTMLElement>(null)
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const live = useRef(enabled)
  useEffect(() => {
    live.current = enabled
  })

  useEffect(() => {
    const node = host.current
    if (!node) return
    const open = (event: MouseEvent) => {
      if (!live.current) return
      event.preventDefault()
      setAt({ x: event.clientX, y: event.clientY })
    }
    node.addEventListener('contextmenu', open)
    return () => node.removeEventListener('contextmenu', open)
  }, [])

  useKeyboardShortcuts(at ? [{ key: 'escape', whileTyping: true, run: () => setAt(null) }] : [], {
    enabled: at !== null,
    modal: true,
  })

  useEffect(() => {
    if (!at) return
    const close = () => setAt(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('blur', close)
    }
  }, [at])

  return (
    <View ref={host as never} style={style}>
      {children}
      {at
        ? createPortal(
            <Menu
              items={items}
              x={at.x}
              y={at.y}
              onChoose={(id) => {
                setAt(null)
                onSelect(id)
              }}
            />,
            document.body,
          )
        : null}
    </View>
  )
}

function Menu({ items, x, y, onChoose }: { items: readonly ContextMenuItem[]; x: number; y: number; onChoose: (id: string) => void }) {
  const height = items.length * ROW_HEIGHT + 10
  // Just past the pointer, as a native menu opens; flipped to fit near an edge.
  const left = x + 2 + MENU_WIDTH > window.innerWidth - 8 ? x - MENU_WIDTH - 2 : x + 2
  const top = y + 2 + height > window.innerHeight - 8 ? Math.max(8, y - height - 2) : y + 2
  return (
    <div
      role="menu"
      // Clicks inside don't count as "elsewhere".
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        position: 'fixed',
        left,
        top,
        width: MENU_WIDTH,
        padding: 5,
        background: '#FFFFFF',
        border: '1px solid #E4E6EA',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(17, 20, 24, 0.14)',
        font: '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        zIndex: 1000,
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => onChoose(item.id)}
          style={{
            display: 'block',
            width: '100%',
            height: ROW_HEIGHT,
            padding: '0 10px',
            border: 0,
            borderRadius: 5,
            background: 'transparent',
            textAlign: 'left',
            font: 'inherit',
            color: item.disabled ? '#A0A6AE' : item.destructive ? '#D92D20' : '#111418',
            cursor: item.disabled ? 'default' : 'pointer',
          }}
          onMouseEnter={(event) => {
            if (!item.disabled) event.currentTarget.style.background = '#F2F3F5'
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent'
          }}
        >
          {item.title}
        </button>
      ))}
    </div>
  )
}
