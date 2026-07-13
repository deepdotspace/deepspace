/**
 * useConversation — Shared hook for conversation messaging.
 *
 * Wraps useQuery/useMutations for conv_messages, conv_reactions, conv_members
 * and returns a ConversationObject. Must be used inside a RecordScope for the
 * conversation DO (conv:{channelId}).
 */

import { useCallback, useMemo } from 'react'
import { useQuery } from '../storage/hooks/useQuery'
import { useMutations } from '../storage/hooks/useMutations'
import { useRecordContext } from '../storage/context'
import { useUser } from '../storage/hooks/useUser'
import type { ConvMessageData, ConvReactionData, ConvMemberData } from '../../shared/types'
import type { MessageRecord, ReactionRecord, MemberRecord, ConversationObject } from './types'

interface UseConversationOptions {
  onMessageSent?: (content: string, parentMessageId?: string) => void
}

export function useConversation(opts?: UseConversationOptions): ConversationObject {
  const { user } = useUser()
  const { ready } = useRecordContext()

  const { records: allMessages } = useQuery<ConvMessageData>('conv_messages', { orderBy: '_created_at' })
  const { records: allReactions } = useQuery<ConvReactionData>('conv_reactions')
  const { records: members } = useQuery<ConvMemberData>('conv_members')

  const messageMut = useMutations<ConvMessageData>('conv_messages')
  const reactionMut = useMutations<ConvReactionData>('conv_reactions')

  const send = useCallback(
    (content: string, parentMessageId?: string, messageType?: string, metadata?: Record<string, unknown>) => {
      messageMut.create({
        Content: content,
        AuthorId: user?.id ?? '',
        ParentId: parentMessageId ?? '',
        Edited: 0,
        MessageType: messageType ?? 'message',
        Metadata: metadata ? JSON.stringify(metadata) : '',
      })
      opts?.onMessageSent?.(content, parentMessageId)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on the precise opts?.onMessageSent callback, not the whole opts object, to avoid recreating send when unrelated opts fields change
    [messageMut, user?.id, opts?.onMessageSent],
  )

  const edit = useCallback(
    (recordId: string, content: string) => {
      const existing = allMessages.find((m) => m.recordId === recordId)
      if (!existing) return
      messageMut.put(recordId, { ...existing.data, Content: content, Edited: 1 })
    },
    [messageMut, allMessages],
  )

  const remove = useCallback(
    (recordId: string) => {
      const existing = allMessages.find((m) => m.recordId === recordId)
      if (!existing) return
      messageMut.put(recordId, {
        ...existing.data,
        Content: '',
        MessageType: 'deleted',
        Metadata: '',
      })
    },
    [messageMut, allMessages],
  )

  const toggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      const existing = allReactions.find(
        (r) => r.data.MessageId === messageId && r.data.Emoji === emoji && r.data.UserId === user?.id,
      )
      if (existing) {
        reactionMut.remove(existing.recordId)
      } else {
        reactionMut.create({ MessageId: messageId, Emoji: emoji, UserId: user?.id ?? '' })
      }
    },
    [reactionMut, allReactions, user?.id],
  )

  return useMemo(
    () => ({
      messages: allMessages as MessageRecord[],
      reactions: allReactions as ReactionRecord[],
      members: members as MemberRecord[],
      status: ready ? ('connected' as const) : ('connecting' as const),
      send,
      edit,
      remove,
      toggleReaction,
    }),
    [allMessages, allReactions, members, ready, send, edit, remove, toggleReaction],
  )
}
