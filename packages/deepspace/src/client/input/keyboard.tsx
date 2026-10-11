/**
 * Keyboard shortcuts in the browser (the React Native app's web build): one
 * capture-phase `keydown` listener for every registered shortcut, so a
 * shortcut wins over a focused control's own handling of the key.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { ShortcutRegistry, type ShortcutModifier } from './shortcuts'
import { ShortcutContext } from './use-keyboard-shortcuts'

const WEB_KEYS: Record<string, string> = {
  ' ': 'space',
  Enter: 'return',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

const appleKeyboard = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

type KeyPress = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** Command is Cmd on Apple keyboards and Ctrl elsewhere; Shift is dropped for a symbol it already produced ("!", "?"). */
export function modifiersOf(event: KeyPress, apple = appleKeyboard()): ShortcutModifier[] {
  const modifiers: ShortcutModifier[] = []
  if (apple ? event.metaKey : event.ctrlKey) modifiers.push('command')
  if (apple && event.ctrlKey) modifiers.push('control')
  if (event.altKey) modifiers.push('option')
  const key = webKeyOf(event)
  const symbol = key.length === 1 && key.toLowerCase() === key.toUpperCase()
  if (event.shiftKey && !symbol) modifiers.push('shift')
  return modifiers
}

/**
 * The shortcut key a press names. Option changes what a letter or digit types
 * on a Mac (Option-K types a ring accent), so with Option the physical key
 * names it, as UIKit's key commands do.
 */
export function webKeyOf(event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey'>): string {
  const physical = event.altKey ? /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code) : null
  if (physical) return (physical[1] ?? physical[2]).toLowerCase()
  return WEB_KEYS[event.key] ?? event.key
}

function typingIn(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function KeyboardShortcutsRoot({ children }: { children?: ReactNode }): ReactElement {
  const [registry] = useState(() => new ShortcutRegistry())
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return
      if (registry.dispatch(webKeyOf(event), modifiersOf(event), typingIn(event.target))) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [registry])
  return <ShortcutContext.Provider value={registry}>{children}</ShortcutContext.Provider>
}
