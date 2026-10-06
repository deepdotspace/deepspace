// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeToForeground } from '../foreground'
import { appOrigin } from '../origin'

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  setVisibility('visible')
})

describe('browser platform modules', () => {
  it('fires when the tab becomes visible, not when it is hidden, until unsubscribed', () => {
    const onForeground = vi.fn()
    const unsubscribe = subscribeToForeground(onForeground)
    setVisibility('hidden')
    expect(onForeground).not.toHaveBeenCalled()
    setVisibility('visible')
    expect(onForeground).toHaveBeenCalledTimes(1)
    unsubscribe()
    setVisibility('hidden')
    setVisibility('visible')
    expect(onForeground).toHaveBeenCalledTimes(1)
  })

  it('uses the page origin', () => {
    expect(appOrigin()).toBe(window.location.origin)
  })
})
