/**
 * Shared messaging types for conversation-based apps.
 */

import type { RecordData } from '../storage/types'
import type {
  ConvMessageData,
  ConvReactionData,
  ConvMemberData,
  ConvReadCursorData,
} from '../../shared/types'

// Re-export the data interfaces for convenience
export type { ConvMessageData, ConvReactionData, ConvMemberData, ConvReadCursorData }

// Typed record aliases
export type MessageRecord = RecordData<ConvMessageData>
export type ReactionRecord = RecordData<ConvReactionData>
export type MemberRecord = RecordData<ConvMemberData>
export type ReadCursorRecord = RecordData<ConvReadCursorData>

export interface GroupedReaction {
  emoji: string
  count: number
  currentUserReacted: boolean
  userIds: string[]
}

// Content parsing types
export type ContentSegment =
  | { type: 'text'; value: string }
  | { type: 'emoji'; value: string; shortcode: string }
  | { type: 'link'; value: string; href: string }
  | { type: 'mention'; userId: string; displayName: string }

export interface LinkPreviewData {
  url: string
  title?: string
  description?: string
  image?: string
  favicon?: string
}

export interface ConversationObject {
  messages: MessageRecord[]
  reactions: ReactionRecord[]
  members: MemberRecord[]
  status: 'connecting' | 'connected'
  send: (content: string, parentMessageId?: string, messageType?: string, metadata?: Record<string, unknown>) => void
  edit: (recordId: string, content: string) => void
  remove: (recordId: string) => void
  toggleReaction: (messageId: string, emoji: string) => void
}
