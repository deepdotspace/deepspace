/**
 * useChatChannel — Find or create a default chat channel, and auto-join.
 *
 * Encapsulates all channel logic so consuming components never need to
 * know about the channels collection. On first mount (when no channel
 * exists yet) it creates a "general" public channel automatically and
 * joins the current user.
 *
 * Usage:
 *   const { channelId, status } = useChatChannel()
 *   if (!channelId) return <Loading />
 *   return <MessageList channelId={channelId} />
 */

import { useEffect, useRef } from 'react'
import { useUser } from 'deepspace'
import { useChannels } from 'deepspace'
import { useChannelMembers } from 'deepspace'
import type { Channel } from 'deepspace'
import type { RecordData } from 'deepspace'

const DEFAULT_CHANNEL_NAME = 'general'

export function useChatChannel(channelName: string = DEFAULT_CHANNEL_NAME) {
  const { user } = useUser()
  const { channels, status, create } = useChannels()
  const hasInitialized = useRef(false)

  // Nothing enforces name uniqueness server-side, so two first visitors can
  // race the one-shot init below and BOTH create the default channel. With a
  // bare .find(), each client then resolves whichever duplicate its local
  // snapshot orders first — split-brain: A and B post into different rooms
  // and never see each other. Pick deterministically (oldest createdAt,
  // recordId tie-break) so every client converges on the same channel once
  // the duplicates sync.
  const defaultChannel = channels
    .filter(
      (c: RecordData<Channel>) =>
        c.data.name === channelName &&
        c.data.type === 'public' &&
        !c.data.archived,
    )
    .sort(
      (a: RecordData<Channel>, b: RecordData<Channel>) =>
        a.createdAt.localeCompare(b.createdAt) || a.recordId.localeCompare(b.recordId),
    )[0]

  const { isMember, join, status: membersStatus } = useChannelMembers(defaultChannel?.recordId)

  // One-shot initialization: create the default channel if it doesn't exist.
  useEffect(() => {
    if (!user || status !== 'ready' || hasInitialized.current) return
    hasInitialized.current = true

    if (!defaultChannel) {
      create({
        name: channelName,
        type: 'public',
        description: 'Default chat channel',
      })
    }
    // Deps intentionally limited to [user, status]: this is a one-shot init
    // guarded by hasInitialized. Including defaultChannel/create/channelName
    // would re-run and defeat the create-once semantics.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot init guarded by hasInitialized; adding defaultChannel/create/channelName would defeat create-once
  }, [user, status])

  // Wait for the members query to be ready before auto-joining.
  useEffect(() => {
    if (!user || !defaultChannel || isMember || membersStatus !== 'ready') return
    join()
  }, [user, defaultChannel, isMember, membersStatus, join])

  return {
    channelId: defaultChannel?.recordId,
    status,
    isMember,
    join,
  }
}
