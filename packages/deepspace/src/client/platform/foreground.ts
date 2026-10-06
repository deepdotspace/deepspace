/**
 * Foreground signal for the browser client.
 *
 * The `deepspace/native` bundle replaces this module with
 * `foreground.native.ts`, so shared client code can react to "the app is
 * visible again" without touching `document` directly.
 */

/** Calls `onForeground` each time the page becomes visible. Returns an unsubscribe function. */
export function subscribeToForeground(onForeground: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') onForeground()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  return () => document.removeEventListener('visibilitychange', onVisibilityChange)
}
