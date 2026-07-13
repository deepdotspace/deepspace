/**
 * useReactions — subscribe to reactions in a channel with toggle.
 */

import { useCallback } from 'react'
import { useQuery } from '../storage/hooks/useQuery'
import { useMutations } from '../storage/hooks/useMutations'
import { useUser } from '../storage/hooks/useUser'
import type { RecordData } from '../storage/types'
import type { Reaction } from './channel-types'
import type { GroupedReaction } from './types'

export function useReactions(channelId: string | undefined) {
  const { user } = useUser()

  const { records, status, error } = useQuery<Reaction>('reactions', {
    where: channelId ? { channelId } : { channelId: '__none__' },
  })

  const { create, remove: removeMutation } = useMutations<Reaction>('reactions')

  const getReactionsForMessage = useCallback(
    (messageId: string): GroupedReaction[] => {
      const messageReactions = records.filter((r) => r.data.messageId === messageId)
      const grouped = new Map<string, string[]>()

      for (const r of messageReactions) {
        if (!grouped.has(r.data.emoji)) grouped.set(r.data.emoji, [])
        grouped.get(r.data.emoji)!.push(r.data.userId)
      }

      return Array.from(grouped.entries()).map(([emoji, userIds]) => ({
        emoji,
        count: userIds.length,
        userIds,
        currentUserReacted: user ? userIds.includes(user.id) : false,
      }))
    },
    [records, user],
  )

  const toggle = useCallback(
    (messageId: string, emoji: string) => {
      if (!channelId || !user) return
      const existing = records.find(
        (r) => r.data.messageId === messageId && r.data.emoji === emoji && r.data.userId === user.id,
      )
      if (existing) {
        removeMutation(existing.recordId)
      } else {
        create({ messageId, channelId, emoji, userId: user.id } as unknown as Reaction)
      }
    },
    [channelId, user, records, create, removeMutation],
  )

  return { reactions: records as RecordData<Reaction>[], status, error, getReactionsForMessage, toggle }
}
