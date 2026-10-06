/**
 * Native replacement for `client/auth/token`, used only by the
 * `deepspace/native` bundle. The Expo client caches and refreshes the bearer,
 * so there is no module cache to clear here.
 */
import { getNativeAuthToken } from '../../native/session'

export function getAuthToken(): Promise<string | null> {
  return getNativeAuthToken()
}

export function clearAuthToken(): void {}
