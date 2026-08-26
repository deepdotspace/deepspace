/**
 * Messaging Types
 *
 * TypeScript interfaces for the messaging collection schemas.
 */

export interface Channel {
  name: string
  description?: string
  type: 'public'
  createdBy: string
  archived: boolean
}

export interface Message {
  channelId: string
  content: string
  authorId: string
  parentMessageId?: string
  edited: boolean
  editedAt?: string
  /** Soft-delete flag. The row stays — UIs render a tombstone. */
  deleted?: boolean
}

export interface Reaction {
  messageId: string
  channelId: string
  emoji: string
  userId: string
}

export interface ChannelMember {
  channelId: string
  userId: string
  joinedAt: string
}

export interface ReadReceipt {
  channelId: string
  userId: string
  lastReadAt: string
}

export interface GroupedReaction {
  emoji: string
  count: number
  currentUserReacted: boolean
  userIds: string[]
}
