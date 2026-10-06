/**
 * Per-user integration consent (for example `google/*`) from React Native.
 *
 * An integration that needs consent answers a success envelope whose `data`
 * carries `requiresOAuth: true` and an `authUrl`. The platform's callback
 * stores the grant server-side for the signed-in user, so the app only has to
 * show that page and retry the original call once the person closes it.
 */
import * as WebBrowser from 'expo-web-browser'

/**
 * The consent URL inside an integration result, or null when none is needed.
 * Reads `data`, falling back to the result itself for a flattened envelope.
 */
export function consentUrlOf(result: { success: boolean; data?: unknown }): string | null {
  if (!result.success) return null
  const payload = (result.data ?? result) as { requiresOAuth?: unknown; authUrl?: unknown } | null
  if (!payload || typeof payload !== 'object') return null
  return payload.requiresOAuth === true && typeof payload.authUrl === 'string'
    ? payload.authUrl
    : null
}

/**
 * Opens a consent URL in the system browser sheet and resolves when the person
 * closes it. Whether they granted access is learned by retrying the call.
 */
export async function openIntegrationConsent(authUrl: string): Promise<void> {
  if (new URL(authUrl).protocol !== 'https:') {
    throw new Error('deepspace/native: integration consent URLs must use https')
  }
  await WebBrowser.openBrowserAsync(authUrl)
}
