/**
 * Shared messaging utility functions.
 */

import type { ReactionRecord, GroupedReaction, MessageRecord } from './types'

export function groupReactionsForMessage(
  reactions: ReactionRecord[],
  messageId: string,
  currentUserId: string,
): GroupedReaction[] {
  const forMessage = reactions.filter((r) => r.data.MessageId === messageId)
  const groups = new Map<string, { count: number; currentUserReacted: boolean; userIds: string[] }>()

  for (const r of forMessage) {
    const existing = groups.get(r.data.Emoji) ?? { count: 0, currentUserReacted: false, userIds: [] }
    existing.count++
    existing.userIds.push(r.data.UserId)
    if (r.data.UserId === currentUserId) existing.currentUserReacted = true
    groups.set(r.data.Emoji, existing)
  }

  return Array.from(groups.entries()).map(([emoji, data]) => ({
    emoji,
    count: data.count,
    currentUserReacted: data.currentUserReacted,
    userIds: data.userIds,
  }))
}

/** Default grouping threshold: 5 minutes */
const GROUPING_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Determine whether a message should be visually grouped with the previous one
 * (same author, within threshold, no date boundary).
 */
export function shouldGroupMessages(
  current: MessageRecord,
  previous: MessageRecord | null | undefined,
  options?: { thresholdMs?: number; dateChanged?: boolean },
): boolean {
  if (!previous) return false
  if (options?.dateChanged) return false
  if (previous.data.AuthorId !== current.data.AuthorId) return false
  const timeDiff = new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime()
  return timeDiff < (options?.thresholdMs ?? GROUPING_THRESHOLD_MS)
}

/**
 * Compute thread reply counts from a flat message array.
 */
export function getThreadCounts(messages: MessageRecord[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of messages) {
    if (m.data.ParentId) {
      counts.set(m.data.ParentId, (counts.get(m.data.ParentId) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Format a message timestamp for display.
 * Returns "2:30 PM" style short time.
 */
export function formatMessageTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Format a full message timestamp.
 * Returns "Mar 5, 2026 at 2:30 PM" style.
 */
export function formatFullTimestamp(dateStr: string): string {
  const date = new Date(dateStr)
  const datePart = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
  const timePart = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${datePart} at ${timePart}`
}
