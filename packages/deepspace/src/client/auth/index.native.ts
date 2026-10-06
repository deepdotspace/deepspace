/**
 * Native replacement for `client/auth`, used only by the `deepspace/native`
 * bundle. The shared storage layer imports `useAuth` and `getAuthToken` from
 * `../auth`; here they read the SecureStore-backed Expo session instead of
 * Better Auth's browser cookie. Browser-only exports (AuthOverlay, AuthGate,
 * Better Auth's client) have no native equivalent and are intentionally absent.
 */
export { useAuth } from '../../native/session'
export { getAuthToken, clearAuthToken } from './token.native'
