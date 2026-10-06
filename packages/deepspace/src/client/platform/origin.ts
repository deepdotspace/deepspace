/**
 * Origin of the app's Worker for the browser client: the page's own origin.
 *
 * The `deepspace/native` bundle replaces this module with `origin.native.ts`,
 * which answers the deployed app URL the native client was created with.
 * An empty string means "use same-origin relative URLs".
 */
export function appOrigin(): string {
  if (typeof window !== 'undefined') return window.location.origin
  return ''
}
