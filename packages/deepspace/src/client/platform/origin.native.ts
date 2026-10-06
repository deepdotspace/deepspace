/**
 * Origin of the app's Worker for React Native: the `baseUrl` of the client
 * passed to `DeepSpaceNativeProvider`. Used only by the `deepspace/native` bundle.
 */
import { requireNativeClient } from '../../native/session'

export function appOrigin(): string {
  return requireNativeClient().origin
}
