/**
 * Per-user integration consent (for example `google/*`) from React Native.
 *
 * An integration that needs consent answers a success envelope whose `data`
 * carries `requiresOAuth: true` and an `authUrl`. The platform's callback
 * stores the grant server-side for the signed-in user, so the app only has to
 * show that page and retry the original call once the person closes it.
 */
import * as WebBrowser from 'expo-web-browser'

export { consentUrlOf } from './consent-url'

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
