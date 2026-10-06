/**
 * Foreground signal for React Native, used only by the `deepspace/native` bundle.
 * An app returning from the background is the native equivalent of a browser
 * tab becoming visible.
 */
import { AppState } from 'react-native'

/** Calls `onForeground` each time the app becomes active. Returns an unsubscribe function. */
export function subscribeToForeground(onForeground: () => void): () => void {
  let previous: string | null | undefined = AppState.currentState
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'active' && previous !== 'active') onForeground()
    previous = next
  })
  return () => subscription.remove()
}
