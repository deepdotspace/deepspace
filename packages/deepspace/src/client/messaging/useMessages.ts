/**
 * useMessages — subscribe to messages in a channel with send/edit/remove.
 */

import { useCallback, useMemo } from 'react'
import { useQuery } from '../storage/hooks/useQuery'
import { useMutations } from '../storage/hooks/useMutations'
import { useUser } from '../storage/hooks/useUser'
import type { RecordData } from '../storage/types'
import type { Message } from './channel-types'

export function useMessages(channelId: string | undefined, options?: { parentMessageId?: string }) {
  const where = useMemo(() => {
    if (!channelId) return { channelId: '__none__' }
    const w: Record<string, unknown> = { channelId }
    if (options?.parentMessageId !== undefined) {
      w.parentMessageId = options.parentMessageId
    }
    return w
  }, [channelId, options?.parentMessageId])

  const { user } = useUser()

  const { records, status, error } = useQuery<Message>('messages', {
    where,
    orderBy: 'createdAt',
    orderDir: 'asc',
  })

  const { create, put, remove: removeMutation } = useMutations<Message>('messages')

  const send = useCallback(
    (content: string, parentMessageId?: string) => {
      if (!channelId || !user) return
      const data: Record<string, unknown> = { channelId, content, authorId: user.id, edited: false }
      if (parentMessageId) data.parentMessageId = parentMessageId
      return create(data as unknown as Message)
    },
    [channelId, user, create],
  )

  const edit = useCallback(
    (messageId: string, newContent: string) => {
      put(messageId, { content: newContent, edited: true } as unknown as Message)
    },
    [put],
  )

  /** Hard-delete: drops the row entirely. Use when threads/replies don't matter. */
  const remove = useCallback(
    (messageId: string) => {
      removeMutation(messageId)
    },
    [removeMutation],
  )

  /**
   * Soft-delete: sets `deleted: true` on the message. The row stays so threads,
   * read-receipts, and parent links remain coherent. UIs render a tombstone
   * (e.g. "This message was deleted.") for messages with `deleted === true`.
   */
  const softDelete = useCallback(
    (messageId: string) => {
      put(messageId, { deleted: true } as unknown as Message)
    },
    [put],
  )

  return {
    messages: records as RecordData<Message>[],
    status,
    error,
    send,
    edit,
    remove,
    softDelete,
  }
}
