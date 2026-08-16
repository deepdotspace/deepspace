/**
 * Storage Types
 *
 * Type definitions for the RecordRoom storage system.
 */

import type { ReactNode } from 'react'
export type { Query } from '../../shared/types'

// ============================================================================
// Record Types
// ============================================================================

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
  /** Present only in the admin user-management view. */
  email?: string
  name: string
  imageUrl?: string
  role: string
  /** Present only in the admin user-management view. */
  createdAt?: string
  /** Present only in the admin user-management view. */
  lastSeenAt?: string
}

// ============================================================================
// Connection Types
// ============================================================================

export type RoomConnectionState = 'connecting' | 'connected' | 'disconnected'

/** A rejected optimistic write. */
export interface WriteError {
  /**
   * `permission` — RBAC denial; `validation` — data validation/other server
   * rejection; `not_ready` — rejected client-side because the room could not
   * accept writes yet (gate the control on `ready` from `useMutations()`).
   */
  kind: 'permission' | 'validation' | 'not_ready'
  /** Short human-readable summary, safe to show end users. */
  title: string
  /** Longer human-readable explanation; may be empty. */
  detail: string
}

export interface RecordProviderProps {
  children: ReactNode
  /**
   * If true, allow anonymous users to connect as read-only viewers.
   * Non-signed-in users skip the sign-in screen and connect
   * to the WebSocket without a userId. The server assigns them
   * an ephemeral anon-* ID with 'viewer' role.
   */
  allowAnonymous?: boolean
  /** Auth token provider for WS connections. */
  getAuthToken?: () => Promise<string | null>
  /**
   * Receives every rejected write — denied or invalid by the server, and
   * attempted before the room was ready. Wire this to app UI so users see
   * changes that didn't land. Defaults to a deduplicated console error.
   */
  onWriteError?: (error: WriteError) => void
}
