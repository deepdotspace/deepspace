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

  const { createConfirmed, removeConfirmed } = useMutations<ChannelMember>('channel-members')

  const join = useCallback(async () => {
    if (!channelId || !user) return
    const existing = records.find((r) => r.data.userId === user.id)
    if (existing) return
    await createConfirmed({
      channelId,
      userId: user.id,
      joinedAt: new Date().toISOString(),
    } as unknown as ChannelMember)
  }, [channelId, user, records, createConfirmed])

  const leave = useCallback(async () => {
    if (!channelId || !user) return
    const membership = records.find((r) => r.data.userId === user.id)
    if (membership) await removeConfirmed(membership.recordId)
  }, [channelId, user, records, removeConfirmed])

  const isMember = user ? records.some((r) => r.data.userId === user.id) : false

  return { members: records as RecordData<ChannelMember>[], status, error, join, leave, isMember }
}
