/**
 * Storage Types
 * 
 * Type definitions for the RecordRoom storage system.
 */

import type { CollectionSchema } from '../../shared/types'

// ============================================================================
// Query Types
// ============================================================================

export interface Query {
  collection: string
  where?: Record<string, unknown>
  orderBy?: string
  orderDir?: 'asc' | 'desc'
  limit?: number
}

export interface RecordData<T = unknown> {
  recordId: string
  data: T
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ============================================================================
// User Types
// ============================================================================

export interface UserKarma {
  total: number
  breakdown: { publishing: number; content: number; comment: number; curation: number }
  rank: number
  monthlyKarma: number
  monthlyRank: number
}

export interface UserCredits {
  total: number
  subscription: number
  bonus: number
  purchased: number
}

/**
 * User profile. Core fields (id, name, email, imageUrl) come from the JWT.
 * Optional fields (billing, karma) can be loaded by the app separately.
 */
export interface UserProfile {
  id: string
  name: string
  email: string
  imageUrl?: string
  isAdmin?: boolean
  publicUsername?: string | null
  subscriptionTier?: string | null
  subscriptionStatus?: string | null
  karma?: UserKarma | null
  credits?: UserCredits | null
}

/**
 * Complete user data combining API profile + room-specific role.
 * 
 * Used by useUser() hook. Merges:
 * - UserProfile from API (karma, credits, isAdmin, etc.)
 * - Room role from WebSocket (derived from user-roles collection)
 */
export interface User extends UserProfile {
  /** User's role in this room (e.g., 'applicant', 'intern', 'admin') */
  role: string
}

/**
 * User info from RecordRoom WebSocket.
 * Used by useUsers() hook for listing other users in the room.
 */
export interface RoomUser {
  id: string
  email: string
  name: string
  imageUrl?: string
  role: string
  createdAt: string
  lastSeenAt: string
}

// ============================================================================
// Connection Types
// ============================================================================

export type RoomConnectionState = 'connecting' | 'connected' | 'disconnected'

/**
 * Function to fetch user profile from API.
 * Uses Better Auth token from the auth module.
 */
export type FetchUserProfile = () => Promise<UserProfile | null>

export interface RecordProviderProps {
  /** Room ID for backward compat. Omit for multi-scope mode (use RecordScope instead). */
  roomId?: string
  schemas?: CollectionSchema[]
  wsUrl?: string
  children: React.ReactNode
  /**
   * Custom function to fetch user profile.
   * If not provided, uses Better Auth session.
   */
  fetchUser?: FetchUserProfile
  /**
   * If true, allow anonymous users to connect as read-only viewers.
   * Non-signed-in users skip the sign-in screen and connect
   * to the WebSocket without a userId. The server assigns them
   * an ephemeral anon-* ID with 'viewer' role.
   */
  allowAnonymous?: boolean
  /** Auth token provider for WS connections. */
  getAuthToken?: () => Promise<string | null>
}
