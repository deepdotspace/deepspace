/**
 * useChannelMembers — subscribe to channel membership with join/leave.
 */

import { useCallback } from 'react'
import { useQuery } from '../storage/hooks/useQuery'
import { useMutations } from '../storage/hooks/useMutations'
import { useUser } from '../storage/hooks/useUser'
import type { RecordData } from '../storage/types'
import type { ChannelMember } from './channel-types'

export function useChannelMembers(channelId: string | undefined) {
  const { user } = useUser()

  const { records, status, error } = useQuery<ChannelMember>('channel-members', {
    where: channelId ? { channelId } : { channelId: '__none__' },
  })

  const { create, remove: removeMutation } = useMutations<ChannelMember>('channel-members')

  const join = useCallback(() => {
    if (!channelId || !user) return
    const existing = records.find((r) => r.data.userId === user.id)
    if (existing) return
    create({ channelId, userId: user.id, joinedAt: new Date().toISOString() } as unknown as ChannelMember)
  }, [channelId, user, records, create])

  const leave = useCallback(() => {
    if (!channelId || !user) return
    const membership = records.find((r) => r.data.userId === user.id)
    if (membership) removeMutation(membership.recordId)
  }, [channelId, user, records, removeMutation])

  const isMember = user ? records.some((r) => r.data.userId === user.id) : false

  return { members: records as RecordData<ChannelMember>[], status, error, join, leave, isMember }
}
