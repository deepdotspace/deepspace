/**
 * Better Auth Client for DeepSpace
 *
 * Creates a typed Better Auth client that communicates via the app's
 * own /api/auth/* proxy (same-origin cookies, no CORS issues).
 * The app's worker proxies these requests to the auth-worker.
 */

import { createAuthClient } from 'better-auth/react'
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins'
import { clearAuthToken } from './token'

/**
 * Auth base URL — always same-origin.
 * The app's worker.ts proxies /api/auth/* to the auth-worker.
 */
function getBaseURL(): string {
  if (typeof window !== 'undefined') {
    return window.location.origin
  }
  return ''
}

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  plugins: [organizationClient(), twoFactorClient()],
})

export const {
  useSession,
  signIn,
  useActiveOrganization,
  useListOrganizations,
} = authClient

export async function signOut(
  ...args: Parameters<typeof authClient.signOut>
): Promise<Awaited<ReturnType<typeof authClient.signOut>>> {
  try {
    return await authClient.signOut(...args)
  } finally {
    clearAuthToken()
  }
}
