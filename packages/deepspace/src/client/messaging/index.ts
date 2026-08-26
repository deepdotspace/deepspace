/**
 * Messaging Module
 *
 * Channel-based messaging hooks for app-owned RecordRooms.
 */

// ── Channel types ────────────────────────────────────────────────────────────
export type { Channel, Message, Reaction, ChannelMember, ReadReceipt } from './channel-types'

// ── Channel hooks ────────────────────────────────────────────────────────────
export { useMessages } from './useMessages'
export { useChannels } from './useChannels'
export { useReactions } from './useReactions'
export type { GroupedReaction } from './channel-types'
export { useChannelMembers } from './useChannelMembers'
export { useReadReceipts } from './useReadReceipts'
