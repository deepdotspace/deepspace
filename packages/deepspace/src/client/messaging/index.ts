/**
 * Messaging Module
 *
 * Two patterns:
 * 1. Channel-based: useChannels, useMessages, useReactions, etc. (app-scope DO)
 * 2. Conversation-scoped: useConversation (conv:{id} DO)
 */

// ── Channel types ────────────────────────────────────────────────────────────
export type { Channel, Message, Reaction, ChannelMember, ReadReceipt, ChannelInvitation } from './channel-types'

// ── Channel hooks ────────────────────────────────────────────────────────────
export { useMessages } from './useMessages'
export { useChannels } from './useChannels'
export { useReactions } from './useReactions'
export type { GroupedReaction } from './types'
export { useChannelMembers } from './useChannelMembers'
export { useReadReceipts } from './useReadReceipts'

// ── Conversation-scoped hook (conv:{id} DOs) ────────────────────────────────
export { useConversation } from './useConversation'
export type {
  MessageRecord,
  ReactionRecord,
  MemberRecord,
  ReadCursorRecord,
  ConversationObject,
  ContentSegment,
  LinkPreviewData,
} from './types'

// ── Utilities ────────────────────────────────────────────────────────────────
export {
  groupReactionsForMessage,
  shouldGroupMessages,
  getThreadCounts,
  formatMessageTime,
  formatFullTimestamp,
} from './utils'
export { getConversationDisplayName, isDMConversation, getConversationParticipantIds } from './conversation-utils'
export { parseMessageMetadata } from './message-utils'
