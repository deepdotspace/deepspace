// @vitest-environment jsdom
/**
 * The web build's stand-ins for native behavior: Alert as an in-page dialog
 * that takes the keyboard, integration consent that resolves when its window
 * closes, and the client's session read from the cookie session.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => {
  let listener: ((value: unknown) => void) | null = null
  return {
    value: { isPending: false, data: null as null | { session: { token: string } } },
    atom: {
      listen: (next: (value: unknown) => void) => {
        listener = next
        return () => (listener = null)
      },
    },
    emit(value: unknown) {
      listener?.(value)
    },
  }
})

vi.mock('../client/auth/client', () => ({
  authClient: {
    $store: { atoms: { session: session.atom } },
    getSession: async () => ({ data: session.value.data }),
  },
  signOut: async () => {},
}))
vi.mock('../client/auth/token', () => ({ getAuthToken: async () => 'bearer' }))
vi.mock('../client/auth/DeepSpaceAuthProvider', () => ({
  DeepSpaceAuthProvider: ({ children }: { children: unknown }) => children,
}))
// React Native Web renders View as a DOM element.
vi.mock('react-native', async () => {
  const { createElement, forwardRef } = await import('react')
  return { View: forwardRef<HTMLDivElement, { children?: ReactNode }>(({ children }, ref) => createElement('div', { ref }, children)) }
})

const { Alert, createDeepSpaceExpoClient, DeepSpaceNativeProvider, openIntegrationConsent } = await import('../native/web')
const { useKeyboardShortcuts } = await import('../client/input/use-keyboard-shortcuts')
const { ContextMenu } = await import('../client/input/context-menu')
const { __resetWebAlertsForTests } = await import('../native/web-alert')
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const answered = vi.fn()

function Screen() {
  useKeyboardShortcuts([{ key: '1', run: answered }, { key: 'escape', run: answered }])
  return null
}

async function key(name: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })
}

beforeEach(async () => {
  __resetWebAlertsForTests()
  answered.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <DeepSpaceNativeProvider client={createDeepSpaceExpoClient()}>
        <Screen />
      </DeepSpaceNativeProvider>,
    ),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('web Alert', () => {
  it('shows every button and runs the one pressed', async () => {
    const later = vi.fn()
    const never = vi.fn()
    await act(async () =>
      Alert.alert('Defer this card?', 'It comes back on its own.', [
        { text: 'Tomorrow', onPress: later },
        { text: 'Next week', onPress: never },
        { text: 'Cancel', style: 'cancel' },
      ]),
    )
    const buttons = [...document.querySelectorAll('[role="alertdialog"] button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Tomorrow', 'Next week', 'Cancel'])
    await act(async () => (buttons[0] as HTMLButtonElement).click())
    expect(later).toHaveBeenCalledTimes(1)
    expect(never).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('takes the keyboard while open: Escape cancels, and the screen below hears nothing', async () => {
    const cancel = vi.fn()
    await act(async () => Alert.alert('Sign out?', undefined, [{ text: 'Cancel', style: 'cancel', onPress: cancel }, { text: 'Sign out' }]))
    await key('1')
    await key('Escape')
    expect(answered).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    await key('1')
    expect(answered).toHaveBeenCalledTimes(1)
  })

  it('Return presses the first button that is not the cancel button', async () => {
    const confirm = vi.fn()
    await act(async () => Alert.alert('Sign out?', undefined, [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', onPress: confirm }]))
    await key('Enter')
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('Return presses the focused button once the person moves focus to another', async () => {
    const cancel = vi.fn()
    const confirm = vi.fn()
    await act(async () =>
      Alert.alert('Delete?', undefined, [{ text: 'Cancel', style: 'cancel', onPress: cancel }, { text: 'Delete', style: 'destructive', onPress: confirm }]),
    )
    const [cancelButton] = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
    cancelButton.focus()
    await act(async () => {
      cancelButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('web ContextMenu', () => {
  it('takes Escape from the screen while open', async () => {
    const chosen = vi.fn()
    await act(async () =>
      root.render(
        <DeepSpaceNativeProvider client={createDeepSpaceExpoClient()}>
          <Screen />
          <ContextMenu items={[{ id: 'copy', title: 'Copy' }]} onSelect={chosen}>
            <span id="target">card</span>
          </ContextMenu>
        </DeepSpaceNativeProvider>,
      ),
    )
    await act(async () => {
      document.getElementById('target')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await key('Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(answered).not.toHaveBeenCalled()
    await key('Escape')
    expect(answered).toHaveBeenCalledTimes(1)
  })
})

describe('web client session', () => {
  it('reads the cookie session with a bearer, and reports changes', async () => {
    const client = createDeepSpaceExpoClient()
    session.value.data = null
    await expect(client.getSession()).resolves.toBeNull()

    session.value.data = { session: { token: 'session-1' } }
    await expect(client.getSession()).resolves.toEqual({ sessionToken: 'session-1', accessToken: 'bearer' })

    const seen = vi.fn()
    const stop = client.subscribe(seen)
    session.emit({ isPending: false, data: { session: { token: 'session-2' } } })
    session.emit({ isPending: false, data: { session: { token: 'session-2' } } })
    session.emit({ isPending: false, data: null })
    await act(async () => {})
    expect(seen.mock.calls.map(([value]) => value)).toEqual([{ sessionToken: 'session-2', accessToken: 'bearer' }, null])
    stop()
  })

  it('keeps delivering real sessions after a listener throws', async () => {
    const client = createDeepSpaceExpoClient()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen = vi.fn((value: unknown) => {
      if (value === null) throw new Error('app bug')
    })
    const stop = client.subscribe(seen)
    session.emit({ isPending: false, data: null })
    session.emit({ isPending: false, data: { session: { token: 'session-3' } } })
    await act(async () => {})
    expect(seen.mock.calls.map(([value]) => value)).toEqual([null, { sessionToken: 'session-3', accessToken: 'bearer' }])
    stop()
    error.mockRestore()
  })
})

describe('web integration consent', () => {
  it('resolves when the consent window closes', async () => {
    vi.useFakeTimers()
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const consent = { closed: false, opener: {} as unknown, location: { href: '' } }
    vi.spyOn(window, 'open').mockReturnValue(consent as unknown as Window)
    let done = false
    const opened = openIntegrationConsent('https://accounts.example.com/consent').then(() => (done = true))
    await vi.advanceTimersByTimeAsync(2000)
    expect(consent.location.href).toBe('https://accounts.example.com/consent')
    expect(consent.opener).toBeNull()
    expect(done).toBe(false)
    consent.closed = true
    await vi.advanceTimersByTimeAsync(600)
    await opened
    expect(done).toBe(true)
    focused.mockRestore()
    vi.useRealTimers()
  })

  it('waits for the person to come back when the window only reads as closed', async () => {
    vi.useFakeTimers()
    // A Cross-Origin-Opener-Policy page severs the handle: closed is true at once.
    const consent = { closed: true, opener: {} as unknown, location: { href: '' } }
    vi.spyOn(window, 'open').mockReturnValue(consent as unknown as Window)
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    let done = false
    const opened = openIntegrationConsent('https://accounts.example.com/consent').then(() => (done = true))
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(false)
    focused.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(600)
    await opened
    expect(done).toBe(true)
    focused.mockRestore()
    vi.useRealTimers()
  })

  it('says so when the browser blocks the window', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(openIntegrationConsent('https://accounts.example.com/consent')).rejects.toThrow(/pop-ups/)
  })
})
