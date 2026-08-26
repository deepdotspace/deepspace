/**
 * useChatChannel — Find or create a default public chat channel.
 *
 * Encapsulates default-channel discovery so consuming components never need
 * to know about the channels collection. On first mount, a member or admin
 * creates the "general" public channel when none exists. Channel membership
 * remains optional and is not used as a read-access gate.
 *
 * Usage:
 *   const { channelId, status } = useChatChannel()
 *   if (!channelId) return <Loading />
 *   return <MessageList channelId={channelId} />
 */

import { useEffect, useRef } from 'react'
import { useUser, isWriterRole } from 'deepspace'
import { useChannels } from 'deepspace'
import type { Channel } from 'deepspace'
import type { RecordData } from 'deepspace'

const DEFAULT_CHANNEL_NAME = 'general'

export function useChatChannel(channelName: string = DEFAULT_CHANNEL_NAME) {
  const { user } = useUser()
  const { channels, status, create } = useChannels()
  // Keyed by channel name, not a boolean: the same mounted hook can be
  // repointed at another channel, which needs its own one-shot create.
  const initializedFor = useRef<string | null>(null)
  const canCreateChannel = isWriterRole(user?.role)

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
        c.data.name === channelName && c.data.type === 'public' && !c.data.archived,
    )
    .sort(
      (a: RecordData<Channel>, b: RecordData<Channel>) =>
        a.createdAt.localeCompare(b.createdAt) || a.recordId.localeCompare(b.recordId),
    )[0]

  // One-shot initialization: create the default channel if it doesn't exist.
  useEffect(() => {
    if (!canCreateChannel || status !== 'ready' || initializedFor.current === channelName) return
    initializedFor.current = channelName

    if (!defaultChannel) {
      void create({
        name: channelName,
        description: 'Default chat channel',
      }).catch(() => {
        // A not-ready write already reaches RecordProvider.onWriteError. Allow
        // a later ready render to retry instead of leaving initialization stuck.
        initializedFor.current = null
      })
    }
  }, [canCreateChannel, status, defaultChannel, create, channelName])

  return {
    channelId: defaultChannel?.recordId,
    status,
  }
}
