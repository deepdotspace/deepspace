/**
 * Auth hooks for the DeepSpace SDK.
 *
 * Thin wrappers over Better Auth's `useSession` that expose the loaded /
 * signed-in / userId / user-profile shape the storage layer reads.
 */

import { useSession } from './client'

/**
 * Sticky-true flag: becomes true once the session query first resolves
 * (success or error) and stays true for the lifetime of the page.
 *
 * Better Auth's underlying query atom briefly flips `isPending` back to
 * true on every background refetch when `data` is `null` — i.e. for
 * anonymous users on every tab-visibility change. Reporting that as
 * `isLoaded: false` would cause consumers (e.g. `RecordProvider`) to
 * unmount and remount their children on each refocus.
 *
 * `isLoaded` here means "the first session check has completed," which
 * is the contract consumers actually want.
 */
let sessionHasResolved = false

function stickyIsLoaded(isPending: boolean): boolean {
  if (!isPending) sessionHasResolved = true
  return sessionHasResolved
}

/**
 * Returns auth state compatible with what storage/context.tsx expects.
 */
export function useAuth() {
  const session = useSession()

  const isSignedIn = !!session.data?.user
  const userId = session.data?.user?.id ?? null

  return {
    isLoaded: stickyIsLoaded(session.isPending),
    isSignedIn,
    userId,
    sessionId: session.data?.session?.id ?? null,
  }
}

/**
 * Returns user data compatible with what storage/context.tsx expects.
 */
export function useAuthUser() {
  const session = useSession()
  const user = session.data?.user ?? null

  return {
    isLoaded: stickyIsLoaded(session.isPending),
    isSignedIn: !!user,
    user: user
      ? {
          id: user.id,
          fullName: user.name ?? null,
          firstName: user.name?.split(' ')[0] ?? null,
          lastName: user.name?.split(' ').slice(1).join(' ') || null,
          emailAddresses: user.email
            ? [{ emailAddress: user.email }]
            : [],
          imageUrl: user.image ?? null,
          primaryEmailAddress: user.email
            ? { emailAddress: user.email }
            : null,
        }
      : null,
  }
}
