/**
 * useUser Hook
 * 
 * Access current user with profile data and room role.
 */

import { useMemo } from 'react'
import { useRecordContext } from '../context'
import type { User } from '../types'

/**
 * Hook to access current user.
 * 
 * Returns merged user data:
 * - Profile from API (karma, credits, subscription, isAdmin)
 * - Role from room (derived from user-roles collection)
 * 
 * The role is the user's role in THIS miniapp/room, which can be
 * different from their global isAdmin status.
 * 
 * @example
 * ```tsx
 * const { user, refetch, isLoading } = useUser()
 * 
 * // Check role
 * if (user?.role === 'admin') { ... }
 * if (user?.role === 'intern') { ... }
 * 
 * // Access karma/credits
 * const karma = user?.karma?.total ?? 0
 * 
 * // Refetch after expensive operations
 * await refetch() // Updates user.credits
 * ```
 */
export function useUser(): {
  user: User | null
  isLoading: boolean
  refetch: () => Promise<void>
} {
  const { userProfile, userProfileLoading, refetchUserProfile, roomRole } = useRecordContext()
  
  // Merge profile + room role into unified User
  const user = useMemo((): User | null => {
    if (!userProfile) return null
    return {
      ...userProfile,
      role: roomRole ?? 'viewer', // Default to 'viewer' if no role set
    }
  }, [userProfile, roomRole])
  
  return { user, isLoading: userProfileLoading, refetch: refetchUserProfile }
}
