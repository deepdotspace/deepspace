/**
 * useReadReceipts — track read state per channel for the current user.
 */

import { useCallback } from 'react'
import { useQuery } from '../storage/hooks/useQuery'
import { useMutations } from '../storage/hooks/useMutations'
import { useUser } from '../storage/hooks/useUser'
import type { RecordData } from '../storage/types'
import type { ReadReceipt, Message } from './channel-types'

export function useReadReceipts() {
  const { user } = useUser()

  const { records, status, error } = useQuery<ReadReceipt>('read-receipts', {
    where: user ? { userId: user.id } : { userId: '__none__' },
  })

  const { create, put } = useMutations<ReadReceipt>('read-receipts')

  const markAsRead = useCallback(
    (channelId: string) => {
      if (!user) return
      const existing = records.find((r) => r.data.channelId === channelId)
      const now = new Date().toISOString()
      if (existing) {
        put(existing.recordId, { lastReadAt: now } as unknown as ReadReceipt)
      } else {
        create({ channelId, userId: user.id, lastReadAt: now } as unknown as ReadReceipt)
      }
    },
    [user, records, create, put],
  )

  const getUnreadCount = useCallback(
    (channelId: string, messages: RecordData<Message>[]): number => {
      const receipt = records.find((r) => r.data.channelId === channelId)
      if (!receipt) return messages.length
      const lastReadAt = new Date(receipt.data.lastReadAt).getTime()
      return messages.filter((m) => new Date(m.createdAt).getTime() > lastReadAt).length
    },
    [records],
  )

  return { receipts: records as RecordData<ReadReceipt>[], status, error, markAsRead, getUnreadCount }
}
