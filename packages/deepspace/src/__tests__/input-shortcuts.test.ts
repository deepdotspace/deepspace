import { describe, expect, it, vi } from 'vitest'
import { modifiersOf, webKeyOf } from '../client/input/keyboard'
import { ShortcutRegistry, type KeyboardShortcut } from '../client/input/shortcuts'

function register(registry: ShortcutRegistry, shortcuts: KeyboardShortcut[], modal = false) {
  const layer = { current: { shortcuts, modal } }
  const remove = registry.register(layer)
  /** Replaces the layer's shortcuts, as a re-render does. */
  const set = (next: KeyboardShortcut[]) => {
    layer.current = { ...layer.current, shortcuts: next }
    registry.changed()
  }
  return { layer, set, remove }
}

describe('ShortcutRegistry', () => {
  it('runs the most recently registered shortcut for a key, so a sheet over a screen takes it', () => {
    const registry = new ShortcutRegistry()
    const screen = vi.fn()
    const sheet = vi.fn()
    register(registry, [{ key: 'escape', run: screen }])
    const { remove } = register(registry, [{ key: 'escape', run: sheet }])
    expect(registry.dispatch('escape', [], false)).toBe(true)
    expect(sheet).toHaveBeenCalledTimes(1)
    expect(screen).not.toHaveBeenCalled()
    remove()
    registry.dispatch('escape', [], false)
    expect(screen).toHaveBeenCalledTimes(1)
  })

  it('lets a plain key type while a text field has focus, unless the shortcut asks for it', () => {
    const registry = new ShortcutRegistry()
    const details = vi.fn()
    const close = vi.fn()
    register(registry, [
      { key: 'space', run: details },
      { key: 'escape', run: close, whileTyping: true },
    ])
    expect(registry.dispatch('space', [], true)).toBe(false)
    expect(details).not.toHaveBeenCalled()
    expect(registry.dispatch('escape', [], true)).toBe(true)
    expect(registry.dispatch('space', [], false)).toBe(true)
    expect(details).toHaveBeenCalledTimes(1)
  })

  it('matches modifiers exactly and ignores their order', () => {
    const registry = new ShortcutRegistry()
    const top = vi.fn()
    const up = vi.fn()
    register(registry, [
      { key: 'up', modifiers: ['option', 'command'], run: top },
      { key: 'up', modifiers: ['command'], run: up },
    ])
    registry.dispatch('up', ['command', 'option'], false)
    expect(top).toHaveBeenCalledTimes(1)
    registry.dispatch('up', ['command'], false)
    expect(up).toHaveBeenCalledTimes(1)
    expect(registry.dispatch('up', [], false)).toBe(false)
  })

  it('lets a modal layer take every key while it is mounted', () => {
    const registry = new ShortcutRegistry()
    const answer = vi.fn()
    const close = vi.fn()
    register(registry, [{ key: '1', run: answer }, { key: 'escape', run: vi.fn() }])
    const dialog = register(registry, [{ key: 'escape', run: close }], true)
    expect(registry.dispatch('1', [], false)).toBe(false)
    expect(registry.snapshot().map((spec) => spec.id)).toEqual(['escape'])
    registry.dispatch('Escape', [], false)
    expect(close).toHaveBeenCalledTimes(1)

    dialog.remove()
    expect(registry.dispatch('1', [], false)).toBe(true)
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('treats letters case-insensitively and calls the latest handler', () => {
    const registry = new ShortcutRegistry()
    const first = vi.fn()
    const second = vi.fn()
    const { set } = register(registry, [{ key: 'F', run: first }])
    set([{ key: 'F', run: second }])
    registry.dispatch('f', [], false)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('gives the native view one spec per combination, and notifies only when the set changes', () => {
    const registry = new ShortcutRegistry()
    const listener = vi.fn()
    registry.subscribe(listener)
    const { layer, set } = register(registry, [
      { key: 'escape', run: () => {}, title: 'Close' },
      { key: 'escape', run: () => {}, whileTyping: true, title: 'Back' },
      { key: '1', run: () => {} },
      { key: 'not a key', run: () => {} },
    ])
    expect(registry.snapshot()).toEqual([
      { id: 'escape', key: 'escape', modifiers: [], whileTyping: true, title: 'Back' },
      { id: '1', key: '1', modifiers: [], whileTyping: false, title: undefined },
    ])
    expect(listener).toHaveBeenCalledTimes(1)
    set([...layer.current.shortcuts])
    expect(listener).toHaveBeenCalledTimes(1)
    set([...layer.current.shortcuts, { key: 'f', run: () => {} }])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(registry.run('1', false)).toBe(true)
  })
})

describe('browser keys', () => {
  const event = (
    key: string,
    flags: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {},
    code = '',
  ) => ({
    key,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...flags,
  })

  it('names keys the way shortcuts do', () => {
    expect(webKeyOf(event(' '))).toBe('space')
    expect(webKeyOf(event('Enter'))).toBe('return')
    expect(webKeyOf(event('ArrowRight'))).toBe('right')
    expect(webKeyOf(event('k'))).toBe('k')
  })

  it('names an Option combination by its physical key, not the character Option types', () => {
    const optionK = event('\u02DA', { altKey: true }, 'KeyK')
    expect(webKeyOf(optionK)).toBe('k')
    expect(modifiersOf(optionK, true)).toEqual(['option'])
    expect(modifiersOf(event('\u02DA', { altKey: true, shiftKey: true }, 'KeyK'), true)).toEqual(['option', 'shift'])
    expect(webKeyOf(event('\u00A1', { altKey: true }, 'Digit1'))).toBe('1')
  })

  it('reads Command as Cmd on Apple keyboards and Ctrl elsewhere', () => {
    expect(modifiersOf(event('k', { metaKey: true }), true)).toEqual(['command'])
    expect(modifiersOf(event('k', { ctrlKey: true }), true)).toEqual(['control'])
    expect(modifiersOf(event('k', { ctrlKey: true }), false)).toEqual(['command'])
  })

  it('drops Shift from a symbol it already produced, but keeps it for letters', () => {
    expect(modifiersOf(event('!', { shiftKey: true }), true)).toEqual([])
    expect(modifiersOf(event('F', { shiftKey: true }), true)).toEqual(['shift'])
  })
})
