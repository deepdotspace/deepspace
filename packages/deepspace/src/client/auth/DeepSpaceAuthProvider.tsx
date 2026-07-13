/**
 * DeepSpace Auth Provider.
 *
 * Wraps the app with the Better Auth session hook so children can read
 * the current user via `useAuth` / `useAuthUser`. Sessions ride a
 * same-origin cookie so there's no satellite-domain configuration.
 */

import React, { useEffect, useRef } from 'react'
import { useSession } from './client'
import { debugLog } from '../debug'

interface DeepSpaceAuthProviderProps {
  children: React.ReactNode
}

/** Logs auth state transitions once. */
function AuthLogger() {
  const session = useSession()
  const isSignedIn = !!session.data?.user
  const prevSignedIn = useRef<boolean | null>(null)

  useEffect(() => {
    if (session.isPending) return
    if (prevSignedIn.current !== isSignedIn) {
      if (isSignedIn) {
        debugLog(`[ds:auth] signed in as ${session.data?.user?.name ?? session.data?.user?.id}`)
      } else if (prevSignedIn.current !== null) {
        debugLog('[ds:auth] signed out')
      }
      prevSignedIn.current = isSignedIn
    }
  }, [isSignedIn, session.isPending, session.data?.user?.name, session.data?.user?.id])

  return null
}

/**
 * Auth provider for DeepSpace apps.
 *
 * Better Auth uses cookie-based sessions, so there's no provider
 * state to manage. This component exists for API compatibility
 * and as a place to add auth-related context in the future.
 */
export function DeepSpaceAuthProvider({ children }: DeepSpaceAuthProviderProps) {
  return (
    <>
      <AuthLogger />
      {children}
    </>
  )
}
