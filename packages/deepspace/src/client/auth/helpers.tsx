/** Conditional renderers, the route gate, and a display-name hook. */

import { useEffect, useRef, type ReactNode } from 'react'
import { useAuth, useAuthUser } from './hooks'
import { AuthOverlay } from './AuthOverlay'

/**
 * Renders children only when the user is signed in.
 */
export function SignedIn({ children }: { children: ReactNode }): React.ReactElement | null {
  const { isLoaded, isSignedIn } = useAuth()
  if (!isLoaded || !isSignedIn) return null
  return <>{children}</>
}

/**
 * Renders children only when the user is signed out.
 */
export function SignedOut({ children }: { children: ReactNode }): React.ReactElement | null {
  const { isLoaded, isSignedIn } = useAuth()
  if (!isLoaded || isSignedIn) return null
  return <>{children}</>
}

export interface AuthGateProps {
  /** Content to show when signed in */
  children: ReactNode
  /**
   * UI for first-visit signed-out users. If omitted, the SDK's sign-in
   * overlay is shown non-closeably. Not used on mid-session sign-out —
   * see `redirectOnSignOut`.
   */
  fallback?: ReactNode
  /** Where to send the user when they sign out from inside the gate. Defaults to '/'. */
  redirectOnSignOut?: string
}

/**
 * Gates a subtree behind sign-in. Children mount only when signed in (no flash).
 * If the user signs out from inside the gate, redirects out instead of trapping
 * them on the overlay.
 */
export function AuthGate({
  children,
  fallback,
  redirectOnSignOut = '/',
}: AuthGateProps): React.ReactElement | null {
  const { isLoaded, isSignedIn } = useAuth()
  const wasSignedIn = useRef(false)
  if (isSignedIn) wasSignedIn.current = true

  if (!isLoaded) return null
  if (isSignedIn) return <>{children}</>
  if (wasSignedIn.current) return <RedirectAway to={redirectOnSignOut} />
  if (fallback) return <>{fallback}</>
  return <AuthOverlay />
}

// Full page load (not a router navigation) so the SDK stays router-agnostic
// and the signed-out teardown is clean.
function RedirectAway({ to }: { to: string }): null {
  useEffect(() => {
    if (typeof window !== 'undefined') window.location.replace(to)
  }, [to])
  return null
}

/**
 * Returns the current user's display name.
 *
 * Resolution order: fullName -> firstName -> email prefix -> 'User'.
 * Returns null when no user is signed in.
 */
export function useDisplayName(): string | null {
  const { user } = useAuthUser()
  if (!user) return null
  return (
    user.fullName ||
    user.firstName ||
    user.primaryEmailAddress?.emailAddress?.split('@')[0] ||
    'User'
  )
}
