/**
 * `Alert.alert` in the web build. React Native Web's Alert does nothing, and
 * the browser's own dialogs offer at most OK and Cancel, so the alert is a
 * small in-page dialog with every button the call passed, in order.
 *
 * `AlertHost`, rendered by the web `DeepSpaceNativeProvider`, shows one alert
 * at a time and takes the keyboard while it is open (a modal shortcut layer):
 * Escape presses the cancel button, Return the focused button (at first the
 * first one that is not the cancel button). Without a mounted host the call
 * falls back to the browser's confirm or alert.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { AlertButton } from 'react-native'
import { useKeyboardShortcuts } from '../client/input/use-keyboard-shortcuts'

interface ShownAlert {
  title: string
  message?: string
  buttons: AlertButton[]
}

let queue: ShownAlert[] = []
let hosts = 0
const listeners = new Set<() => void>()

function publish(next: ShownAlert[]): void {
  queue = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const currentAlert = (): ShownAlert | undefined => queue[0]

/** The cancel button, or the only button; what Escape presses. */
function cancelOf(buttons: AlertButton[]): AlertButton | undefined {
  return buttons.find((button) => button.style === 'cancel') ?? (buttons.length === 1 ? buttons[0] : undefined)
}

/** The button focused when the alert opens: the first one that is not the cancel button. */
function defaultOf(buttons: AlertButton[]): AlertButton | undefined {
  return buttons.find((button) => button.style !== 'cancel') ?? buttons[0]
}

function browserFallback({ title, message, buttons }: ShownAlert): void {
  const text = message ? `${title}\n\n${message}` : title
  const cancel = buttons.find((button) => button.style === 'cancel')
  const action = buttons.find((button) => button !== cancel)
  if (cancel && action) {
    if (window.confirm(text)) action.onPress?.()
    else cancel.onPress?.()
    return
  }
  window.alert(text)
  buttons[0]?.onPress?.()
}

export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[]): void {
    const shown = { title, message, buttons: buttons?.length ? buttons : [{ text: 'OK' }] }
    if (hosts === 0) browserFallback(shown)
    else publish([...queue, shown])
  },
}

function press(button: AlertButton | undefined): void {
  if (!button) return
  publish(queue.slice(1))
  button.onPress?.()
}

export function AlertHost(): ReactElement | null {
  useEffect(() => {
    hosts += 1
    return () => {
      hosts -= 1
    }
  }, [])
  const alert = useSyncExternalStore(subscribe, currentAlert, currentAlert)
  const dialog = useRef<HTMLDivElement>(null)
  // Return presses the focused button, as it would without the shortcut, so
  // tabbing to Cancel and pressing Return cancels.
  const focusedOr = (fallback: AlertButton | undefined, buttons: AlertButton[]) => {
    const elements = [...(dialog.current?.querySelectorAll('button') ?? [])]
    const index = elements.indexOf(document.activeElement as HTMLButtonElement)
    return index >= 0 ? buttons[index] : fallback
  }
  useKeyboardShortcuts(
    alert
      ? [
          { key: 'escape', whileTyping: true, run: () => press(cancelOf(alert.buttons)) },
          { key: 'return', whileTyping: true, run: () => press(focusedOr(defaultOf(alert.buttons), alert.buttons)) },
        ]
      : [],
    { enabled: alert !== undefined, modal: true },
  )
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    first.current?.focus()
  }, [alert])
  if (!alert) return null
  const preferred = defaultOf(alert.buttons)
  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(17, 20, 24, 0.32)',
        zIndex: 1100,
        font: '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-label={alert.title}
        style={{
          width: '100%',
          maxWidth: 320,
          padding: 20,
          background: '#FFFFFF',
          borderRadius: 8,
          boxShadow: '0 12px 32px rgba(17, 20, 24, 0.2)',
          color: '#111418',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, overflowWrap: 'anywhere' }}>{alert.title}</div>
        {alert.message ? (
          <div style={{ marginTop: 8, color: '#4B525B', lineHeight: 1.45, overflowWrap: 'anywhere' }}>{alert.message}</div>
        ) : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          {alert.buttons.map((button, index) => (
            <button
              key={`${index}-${button.text}`}
              ref={button === preferred ? first : undefined}
              type="button"
              onClick={() => press(button)}
              style={{
                minHeight: 32,
                padding: '0 14px',
                borderRadius: 6,
                border: button === preferred ? 0 : '1px solid #D5D9DE',
                background: button === preferred ? (button.style === 'destructive' ? '#D92D20' : '#111418') : '#FFFFFF',
                color: button === preferred ? '#FFFFFF' : button.style === 'destructive' ? '#D92D20' : '#111418',
                font: 'inherit',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {button.text ?? 'OK'}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Test hook: forget queued alerts and mounted hosts. */
export function __resetWebAlertsForTests(): void {
  queue = []
  hosts = 0
  listeners.clear()
}
