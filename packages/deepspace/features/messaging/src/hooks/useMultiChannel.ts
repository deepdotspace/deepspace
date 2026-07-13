/**
 * useMultiChannel — Multi-channel state management.
 *
 * Manages the active channel selection. Provides channel lists filtered
 * by type and helpers for DM display names and unread.
 *
 * DM visibility: DM channels use a `dm-{id1}-{id2}` naming convention.
 * A DM appears in a user's sidebar if their ID is embedded in the channel
 * name, regardless of whether a membership record exists yet.
 */

import { useState, useCallback, useMemo } from 'react'
import { useUser } from 'deepspace'
import { useUsers } from 'deepspace'
import { useChannels } from 'deepspace'
import { useReadReceipts } from 'deepspace'
import { useQuery } from 'deepspace'
import type { Channel, ChannelMember, ChannelInvitation } from 'deepspace'
import type { RecordData } from 'deepspace'

const CHANNEL_TYPES = {
  PUBLIC: 'public',
  PRIVATE: 'private',
  DM: 'dm',
} as const

export type ChannelType = (typeof CHANNEL_TYPES)[keyof typeof CHANNEL_TYPES]

export { CHANNEL_TYPES }

export function useMultiChannel() {
  const { user } = useUser()
  const { users } = useUsers()
  const { channels, status } = useChannels()
  const { receipts, markAsRead } = useReadReceipts()
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null)

  const { records: myMemberships } = useQuery<ChannelMember>('channel-members', {
    where: user ? { userId: user.id } : { userId: '__none__' },
  })

  const myChannelIds = useMemo(
    () => new Set(
      myMemberships.map((m: RecordData<ChannelMember>) => m.data.channelId)
    ),
    [myMemberships]
  )

  const liveChannels = useMemo(
    () => channels.filter((c: RecordData<Channel>) => !c.data.archived),
    [channels]
  )

  const groups = useMemo(
    () => {
      if (!user) return []
      return liveChannels.filter(
        (c: RecordData<Channel>) =>
          (c.data.type === CHANNEL_TYPES.PUBLIC || c.data.type === CHANNEL_TYPES.PRIVATE) &&
          myChannelIds.has(c.recordId)
      )
    },
    [liveChannels, myChannelIds, user]
  )

  /** DMs visible to the current user -- matched by user ID in channel name, not membership */
  const dms = useMemo(
    () => {
      if (!user) return []
      return liveChannels.filter(
        (c: RecordData<Channel>) =>
          c.data.type === CHANNEL_TYPES.DM &&
          c.data.name.includes(user.id)
      )
    },
    [liveChannels, user]
  )

  // Use `where` for the immutable `invitedUserId` field so the SDK filters
  // at query-time and gates real-time creates. `status` is mutable (pending ->
  // accepted/declined), so we filter it client-side in the `useMemo` below.
  const { records: myInvitations } = useQuery<ChannelInvitation>('channel-invitations', {
    where: user ? { invitedUserId: user.id } : { invitedUserId: '__none__' },
  })

  const pendingInvitations = useMemo(
    () => {
      return myInvitations
        .filter((inv: RecordData<ChannelInvitation>) => inv.data.status === 'pending')
        .filter((inv: RecordData<ChannelInvitation>) => {
          const ch = liveChannels.find((c: RecordData<Channel>) => c.recordId === inv.data.channelId)
          return ch && !ch.data.archived
        })
        .map((inv: RecordData<ChannelInvitation>) => {
          const ch = liveChannels.find((c: RecordData<Channel>) => c.recordId === inv.data.channelId)
          return { invitation: inv, channel: ch }
        })
    },
    [myInvitations, liveChannels]
  )

  const hasUnread = useCallback(
    (channelId: string): boolean => {
      if (channelId === activeChannelId) return false
      const receipt = receipts.find((r) => r.data.channelId === channelId)
      return !receipt
    },
    [receipts, activeChannelId]
  )

  const getDMDisplayName = useCallback(
    (channel: RecordData<Channel>): string => {
      if (!user) return channel.data.name
      const dmName = channel.data.name
      const parts = dmName.replace('dm-', '').split('-')
      const otherId = parts.find((id) => id !== user.id) ?? parts[0]
      const otherUser = users.find((u) => u.id === otherId)
      return otherUser?.name ?? channel.data.description ?? 'Direct Message'
    },
    [user, users]
  )

  const selectChannel = useCallback(
    (id: string) => {
      setActiveChannelId(id)
      markAsRead(id)
    },
    [markAsRead]
  )

  return {
    activeChannelId,
    selectChannel,
    channels: liveChannels,
    groups,
    dms,
    pendingInvitations,
    status,
    hasUnread,
    getDMDisplayName,
  }
}
