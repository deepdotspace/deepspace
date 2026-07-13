/**
 * Conversation Display Utilities
 *
 * Shared helpers for rendering conversation names, participant lists,
 * and type checks across apps (slack-clone, discord-clone, etc.).
 */

import type { UserInfo } from '../storage/hooks/useUserLookup'

interface ConversationData {
  Name: string
  Type: string
  ParticipantIds: string
  ParticipantHash: string
}

/**
 * Get a display name for a conversation.
 *
 * - Channels: use Name field
 * - DMs: look up the other participant's name
 * - Group DMs: "User A, User B, +N"
 */
export function getConversationDisplayName(
  conversation: { data: ConversationData },
  currentUserId: string,
  getUser: (id: string) => UserInfo | undefined,
): string {
  const { Type, Name } = conversation.data

  if (Type !== 'dm' && Type !== 'group') {
    return Name || 'Untitled'
  }

  const ids = getConversationParticipantIds(conversation, currentUserId)

  if (ids.length === 0) return 'Unknown'

  if (Type === 'dm') {
    const other = getUser(ids[0])
    return other?.name ?? 'Unknown'
  }

  // Group DM
  const MAX_NAMES = 3
  const names: string[] = []
  for (let i = 0; i < Math.min(ids.length, MAX_NAMES); i++) {
    const u = getUser(ids[i])
    names.push(u?.name?.split(' ')[0] ?? 'Unknown')
  }
  const remaining = ids.length - MAX_NAMES
  if (remaining > 0) {
    return `${names.join(', ')}, +${remaining}`
  }
  return names.join(', ')
}

/**
 * Check if a conversation type is a DM or group DM.
 */
export function isDMConversation(type: string): boolean {
  return type === 'dm' || type === 'group'
}

/**
 * Parse participant IDs from a conversation.
 * Tries ParticipantIds JSON first, falls back to ParticipantHash (colon-separated).
 */
export function getConversationParticipantIds(
  conversation: { data: Pick<ConversationData, 'ParticipantIds' | 'ParticipantHash'> },
  excludeUserId?: string,
): string[] {
  let ids: string[] = []

  // Try ParticipantIds JSON first
  try {
    const parsed = JSON.parse(conversation.data.ParticipantIds)
    if (Array.isArray(parsed) && parsed.length > 0) {
      ids = parsed
    }
  } catch {
    // fall through to ParticipantHash
  }

  // Fallback to ParticipantHash (colon-separated user IDs)
  if (ids.length === 0 && conversation.data.ParticipantHash) {
    ids = conversation.data.ParticipantHash.split(':')
  }

  if (excludeUserId) {
    return ids.filter((id) => id !== excludeUserId)
  }
  return ids
}
