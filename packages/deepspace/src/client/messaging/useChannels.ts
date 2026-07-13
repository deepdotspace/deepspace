/**
 * useChannels — subscribe to channels with create/archive/update.
 */

import { useCallback } from 'react'
import { useQuery } from '../storage/hooks/useQuery'
import { useMutations } from '../storage/hooks/useMutations'
import { useUser } from '../storage/hooks/useUser'
import type { RecordData } from '../storage/types'
import type { Channel } from './channel-types'

export function useChannels() {
  const { user } = useUser()
  const { records, status, error } = useQuery<Channel>('channels', {
    orderBy: 'createdAt',
    orderDir: 'asc',
  })

  const { create: createMutation, put, remove } = useMutations<Channel>('channels')

  const create = useCallback(
    (data: { name: string; type: Channel['type']; description?: string }) => {
      return createMutation({
        name: data.name,
        type: data.type,
        description: data.description ?? '',
        createdBy: user?.id ?? '',
        archived: false,
      } as unknown as Channel)
    },
    [user, createMutation],
  )

  const archive = useCallback(
    (channelId: string) => {
      put(channelId, { archived: true } as unknown as Channel)
    },
    [put],
  )

  const update = useCallback(
    (channelId: string, data: Partial<Pick<Channel, 'name' | 'description'>>) => {
      put(channelId, data as unknown as Channel)
    },
    [put],
  )

  return {
    channels: records as RecordData<Channel>[],
    status,
    error,
    create,
    archive,
    update,
    remove,
  }
}
