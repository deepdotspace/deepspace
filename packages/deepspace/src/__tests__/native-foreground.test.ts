import { beforeEach, describe, expect, it, vi } from 'vitest'

const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>()
  return {
    listeners,
    currentState: 'active' as string,
    set(next: string) {
      for (const listener of [...listeners]) listener(next)
    },
  }
})

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState
    },
    addEventListener: (_type: 'change', listener: (state: string) => void) => {
      appState.listeners.add(listener)
      return { remove: () => appState.listeners.delete(listener) }
    },
  },
}))

beforeEach(() => {
  appState.listeners.clear()
  appState.currentState = 'active'
})

describe('native foreground signal', () => {
  it('fires only on a transition back to active, until unsubscribed', async () => {
    const { subscribeToForeground } = await import('../client/platform/foreground.native')
    const onForeground = vi.fn()
    const unsubscribe = subscribeToForeground(onForeground)

    appState.set('active')
    expect(onForeground).not.toHaveBeenCalled()
    appState.set('inactive')
    appState.set('background')
    appState.set('active')
    expect(onForeground).toHaveBeenCalledTimes(1)

    unsubscribe()
    appState.set('background')
    appState.set('active')
    expect(onForeground).toHaveBeenCalledTimes(1)
    expect(appState.listeners.size).toBe(0)
  })
})
