/**
 * Keyboard shortcuts for React Native apps, shared by the native and browser
 * implementations (`keyboard.native.tsx`, `keyboard.tsx`): the shortcut shape,
 * the registry every mounted `useKeyboardShortcuts` adds to, and which
 * registered shortcut a key press runs.
 *
 * The most recently registered matching shortcut wins, so a sheet or a screen
 * mounted over another can take a key without the one below it firing too.
 */

/** A named key or one printable character ("1", "f", "]", "-"). */
export type ShortcutKey =
  | 'space'
  | 'return'
  | 'escape'
  | 'tab'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | (string & {})

/** `command` is the Command key on Apple keyboards and Control elsewhere. */
export type ShortcutModifier = 'command' | 'shift' | 'option' | 'control'

export interface KeyboardShortcut {
  key: ShortcutKey
  modifiers?: readonly ShortcutModifier[]
  /**
   * Also run while a text field is being typed in, as Escape or Command-Return
   * usually should. Off by default, so a plain letter or Space types normally.
   */
  whileTyping?: boolean
  /** Listed in the iPad keyboard-shortcut overlay (hold Command). */
  title?: string
  run: () => void
}

/** A shortcut as the native view receives it: everything but the handler, plus the id it reports back. */
export interface ShortcutSpec {
  id: string
  key: string
  modifiers: ShortcutModifier[]
  whileTyping: boolean
  title?: string
}

const NAMED_KEYS = new Set(['space', 'return', 'escape', 'tab', 'delete', 'up', 'down', 'left', 'right'])
const MODIFIER_ORDER: ShortcutModifier[] = ['control', 'option', 'shift', 'command']

/** A key in the form the registry compares: a named key, or one lower-case character. */
export function normalizeKey(key: string): string | null {
  const lowered = key.toLowerCase()
  if (NAMED_KEYS.has(lowered)) return lowered
  if (key === ' ') return 'space'
  return [...key].length === 1 ? lowered : null
}

function comboOf(key: string, modifiers: readonly ShortcutModifier[]): string {
  const sorted = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier))
  return [...sorted, key].join('+')
}

/** One hook's registration; both fields are read live, so a re-render needs no re-register. */
export interface ShortcutLayer {
  shortcuts: readonly KeyboardShortcut[]
  /** While set, the layers registered before this one neither run nor show (a dialog over a screen). */
  modal: boolean
}

interface Entry {
  order: number
  layer: { current: ShortcutLayer }
}

/**
 * The shortcuts every mounted hook has registered. One per provider; the
 * native view and the browser listener both read it.
 */
export class ShortcutRegistry {
  private entries = new Map<symbol, Entry>()
  private order = 0
  private listeners = new Set<() => void>()
  private signature = ''
  private current: ShortcutSpec[] = []

  /** Adds a hook's layer; returns the function that removes it. */
  register(layer: { current: ShortcutLayer }): () => void {
    const id = Symbol('shortcuts')
    this.entries.set(id, { order: ++this.order, layer })
    this.changed()
    return () => {
      this.entries.delete(id)
      this.changed()
    }
  }

  /** Call after a hook's shortcut list may have changed shape (keys, modifiers, titles). */
  changed(): void {
    const specs = this.specs()
    const next = JSON.stringify(specs)
    if (next === this.signature) return
    this.signature = next
    this.current = specs
    for (const listener of [...this.listeners]) listener()
  }

  /** For `useSyncExternalStore`: notifies when the set of key combinations changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The specs as of the last change; the same array until the next one. */
  snapshot = (): ShortcutSpec[] => this.current

  /**
   * One spec per distinct key combination; `whileTyping` if any shortcut for
   * it allows typing, and the title of the one that runs (the latest).
   */
  specs(): ShortcutSpec[] {
    const byCombo = new Map<string, ShortcutSpec>()
    for (const shortcut of this.all()) {
      const key = normalizeKey(shortcut.key)
      if (!key) continue
      const modifiers = MODIFIER_ORDER.filter((modifier) => shortcut.modifiers?.includes(modifier))
      const id = comboOf(key, modifiers)
      const existing = byCombo.get(id)
      if (existing) {
        existing.whileTyping ||= shortcut.whileTyping === true
        existing.title = shortcut.title ?? existing.title
      } else {
        byCombo.set(id, { id, key, modifiers, whileTyping: shortcut.whileTyping === true, title: shortcut.title })
      }
    }
    return [...byCombo.values()]
  }

  /**
   * Runs the most recently registered shortcut for this key combination.
   * Returns whether one ran, so the caller can stop the key's default action.
   */
  dispatch(key: string, modifiers: readonly ShortcutModifier[], typing: boolean): boolean {
    const normalized = normalizeKey(key)
    if (!normalized) return false
    return this.run(comboOf(normalized, modifiers), typing)
  }

  /** Runs the most recent shortcut for a spec id (`comboOf`), as the native view reports it. */
  run(combo: string, typing: boolean): boolean {
    const candidates = this.all().reverse()
    const match = candidates.find((shortcut) => {
      const key = normalizeKey(shortcut.key)
      return key !== null && comboOf(key, shortcut.modifiers ?? []) === combo && (!typing || shortcut.whileTyping === true)
    })
    if (!match) return false
    match.run()
    return true
  }

  /** Every live shortcut, oldest first, starting at the most recent modal layer. */
  private all(): KeyboardShortcut[] {
    const layers = [...this.entries.values()].sort((a, b) => a.order - b.order).map((entry) => entry.layer.current)
    let from = 0
    layers.forEach((layer, index) => {
      if (layer.modal) from = index
    })
    return layers.slice(from).flatMap((layer) => [...layer.shortcuts])
  }
}
