/**
 * `useKeyboardShortcuts`, the same on iPhone, iPad, Mac and the web. The
 * provider's root (`keyboard.tsx` / `keyboard.native.tsx`) owns the registry
 * and turns key presses into calls.
 */
import { createContext, useContext, useEffect, useRef } from 'react'
import type { KeyboardShortcut, ShortcutLayer, ShortcutRegistry } from './shortcuts'

export const ShortcutContext = createContext<ShortcutRegistry | null>(null)

const OFF: ShortcutLayer = { shortcuts: [], modal: false }

export interface KeyboardShortcutOptions {
  /** Default true. While false the shortcuts are off, as if unmounted. */
  enabled?: boolean
  /**
   * Shortcuts registered before this one (the screen below a dialog or
   * sheet) neither run nor show while this one is mounted and enabled,
   * even for keys this one does not use.
   */
  modal?: boolean
}

/**
 * Keyboard shortcuts while this component is mounted (and `enabled`). The
 * latest handlers always run. When two mounted components register the same
 * key, the one registered last wins, so a sheet over a screen can take it;
 * `modal` takes every key. Needs `DeepSpaceNativeProvider` above it.
 */
export function useKeyboardShortcuts(
  shortcuts: readonly KeyboardShortcut[],
  { enabled = true, modal = false }: KeyboardShortcutOptions = {},
): void {
  const registry = useContext(ShortcutContext)
  if (!registry) {
    throw new Error('deepspace/native: useKeyboardShortcuts needs <DeepSpaceNativeProvider> above it.')
  }
  const current = useRef<ShortcutLayer>(OFF)
  useEffect(() => registry.register(current), [registry])
  useEffect(() => {
    current.current = enabled ? { shortcuts, modal } : OFF
    registry.changed()
  })
}
