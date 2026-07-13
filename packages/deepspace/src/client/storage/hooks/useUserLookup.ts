/**
 * useUserLookup Hook
 * 
 * Provides helper functions to look up user information by userId.
 * This is a convenience wrapper around useUsers() that provides O(1) lookups.
 * 
 * The authoritative user data comes from the users collection.
 */

import { useMemo, useCallback } from 'react'
import { useUsers } from './useUsers'

export interface UserInfo {
  id: string
  email: string
  name: string
  imageUrl?: string
  role: string
}

/**
 * Hook for looking up user information by ID.
 * 
 * @example
 * ```tsx
 * const { getUser, getEmail, getName } = useUserLookup()
 * 
 * // Get full user info
 * const user = getUser(userId)
 * 
 * // Get just email
 * const email = getEmail(userId)
 * ```
 */
export function useUserLookup() {
  const { users, usersLoaded } = useUsers()
  
  // Build a lookup map for O(1) access
  const userMap = useMemo(() => {
    const map = new Map<string, UserInfo>()
    for (const user of users) {
      map.set(user.id, {
        id: user.id,
        email: user.email,
        name: user.name,
        imageUrl: user.imageUrl,
        role: user.role,
      })
    }
    return map
  }, [users])
  
  /**
   * Get full user info by userId
   */
  const getUser = useCallback((userId: string): UserInfo | null => {
    return userMap.get(userId) ?? null
  }, [userMap])
  
  /**
   * Get user's email by userId
   */
  const getEmail = useCallback((userId: string): string | null => {
    return userMap.get(userId)?.email ?? null
  }, [userMap])
  
  /**
   * Get user's name by userId
   */
  const getName = useCallback((userId: string): string | null => {
    return userMap.get(userId)?.name ?? null
  }, [userMap])
  
  return {
    /** All users from the users collection */
    users,
    /** True once the user list has been received from the server. */
    usersLoaded,
    /** Map of userId -> UserInfo for direct access */
    userMap,
    /** Get full user info by userId */
    getUser,
    /** Get user email by userId */
    getEmail,
    /** Get user name by userId */
    getName,
  }
}
