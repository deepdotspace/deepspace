/**
 * useConversations Hook
 *
 * Standardized conversation directory backed by the `conversations` and
 * `conversation_state` collections in the dir:{appName} DO.
 *
 * Apps that need a sidebar list of channels / DMs / threads should:
 * 1. Add { type: 'dir', instanceId: APP_ID } to SHARED_CONNECTIONS.
 * 2. Call useConversations() inside a RecordProvider.
 */

import { useCallback, useMemo, useRef } from 'react'
import { useQuery } from '../storage/hooks/useQuery'
import { useMutations } from '../storage/hooks/useMutations'
import { useUser } from '../storage/hooks/useUser'
import type { RecordData } from '../storage/types'
import type { DirectoryConversationData, ConversationStateData } from '../../shared/types'

// Module-scoped constant so it's a stable reference across renders (safe to
// list in useCallback deps without recreating the callback every render).
const defaultConvFields = {
  Visibility: 'public',
  Status: 'active',
  AssigneeId: '',
  LinkedRef: '',
  MessageCount: 0,
}

export function useConversations() {
  const { records: conversations, status } = useQuery<DirectoryConversationData>('conversations')
  const { create, put } = useMutations<DirectoryConversationData>('conversations')
  const { records: stateRecords } = useQuery<ConversationStateData>('conversation_state')
  const stateMut = useMutations<ConversationStateData>('conversation_state')
  const { user } = useUser()

  const ready = status === 'ready'

  const recentCreationsRef = useRef(new Map<string, DirectoryConversationData>())
  for (const [id] of recentCreationsRef.current) {
    if (conversations.find((c) => c.recordId === id)) {
      recentCreationsRef.current.delete(id)
    }
  }

  const readStateMap = useMemo(
    () => new Map(stateRecords.map((r) => [r.data.ConversationId, r.data.LastReadAt])),
    [stateRecords],
  )

  const readMessageCountMap = useMemo(
    () => new Map(stateRecords.map((r) => [r.data.ConversationId, r.data.LastReadMessageCount ?? 0])),
    [stateRecords],
  )

  const starredSet = useMemo(
    () => new Set(stateRecords.filter((r) => r.data.Starred).map((r) => r.data.ConversationId)),
    [stateRecords],
  )

  const archivedSet = useMemo(
    () => new Set(stateRecords.filter((r) => r.data.Archived).map((r) => r.data.ConversationId)),
    [stateRecords],
  )


  const getConversationState = useCallback(
    (conversationId: string): ConversationStateData | undefined => {
      return stateRecords.find((r) => r.data.ConversationId === conversationId)?.data
    },
    [stateRecords],
  )

  const createChannel = useCallback(
    async (name: string, description?: string) => {
      const existing = conversations.find((r) => r.data.Name === name && r.data.Type !== 'dm')
      if (existing) return existing.recordId

      const recordId = await create({
        Name: name,
        Description: description ?? '',
        Type: 'public',
        CreatedBy: user?.id ?? '',
        ParticipantHash: '',
        ParticipantIds: '',
        LastMessageAt: '',
        LastMessagePreview: '',
        LastMessageAuthor: '',
        ...defaultConvFields,
      })
      return recordId
    },
    [create, user?.id, conversations],
  )

  const createDM = useCallback(
    async (otherUserId: string) => {
      if (!user?.id) return null
      const hash = [user.id, otherUserId].sort().join(':')

      const existing = conversations.find((r) => r.data.ParticipantHash === hash)
      if (existing) return existing.recordId

      const data: DirectoryConversationData = {
        Name: '',
        Description: '',
        Type: 'dm',
        Visibility: 'private',
        CreatedBy: user.id,
        ParticipantHash: hash,
        ParticipantIds: JSON.stringify([user.id, otherUserId]),
        Status: 'active',
        AssigneeId: '',
        LinkedRef: '',
        LastMessageAt: '',
        LastMessagePreview: '',
        LastMessageAuthor: '',
        MessageCount: 0,
      }
      const recordId = await create(data)
      recentCreationsRef.current.set(recordId, data)
      return recordId
    },
    [create, user?.id, conversations],
  )

  const createGroupDM = useCallback(
    async (participantIds: string[]) => {
      if (!user?.id) return null
      // Add current user + deduplicate
      const allIds = [...new Set([user.id, ...participantIds])]
      if (allIds.length < 3) return null // Use createDM for 2 participants

      const hash = allIds.sort().join(':')

      const existing = conversations.find((r) => r.data.ParticipantHash === hash)
      if (existing) return existing.recordId

      const data: DirectoryConversationData = {
        Name: '',
        Description: '',
        Type: 'group',
        Visibility: 'private',
        CreatedBy: user.id,
        ParticipantHash: hash,
        ParticipantIds: JSON.stringify(allIds),
        Status: 'active',
        AssigneeId: '',
        LinkedRef: '',
        LastMessageAt: '',
        LastMessagePreview: '',
        LastMessageAuthor: '',
        MessageCount: 0,
      }
      const recordId = await create(data)
      recentCreationsRef.current.set(recordId, data)
      return recordId
    },
    [create, user?.id, conversations],
  )

  const lookupByName = useCallback(
    (name: string) => {
      const found = conversations.find((r) => r.data.Name === name)
      return found?.recordId ?? null
    },
    [conversations],
  )

  const updateLastMessage = useCallback(
    (conversationId: string, preview: string, authorId?: string) => {
      const conv = conversations.find((c) => c.recordId === conversationId)
      const baseData = conv?.data ?? recentCreationsRef.current.get(conversationId)
      if (!baseData) return
      const updatedData = {
        ...baseData,
        LastMessageAt: new Date().toISOString(),
        LastMessagePreview: preview.slice(0, 100),
        LastMessageAuthor: authorId ?? baseData.LastMessageAuthor,
        MessageCount: (baseData.MessageCount ?? 0) + 1,
      }
      put(conversationId, updatedData)
      if (recentCreationsRef.current.has(conversationId)) {
        recentCreationsRef.current.set(conversationId, updatedData)
      }
    },
    [put, conversations],
  )

  /** Upsert the user's conversation_state row for a conversation. */
  const upsertState = useCallback(
    (conversationId: string, partial: Partial<ConversationStateData>) => {
      if (!user?.id) return
      const existing = stateRecords.find(
        (r) => r.data.ConversationId === conversationId && r.data.UserId === user.id,
      )
      const base: ConversationStateData = existing?.data ?? {
        ConversationId: conversationId,
        UserId: user.id,
        LastReadAt: '',
        LastReadMessageCount: 0,
        Starred: 0,
        Archived: 0,
        Trashed: 0,
        Labels: '',
        Folder: '',
      }
      const recordId = existing?.recordId ?? `state-${user.id}-${conversationId}`
      stateMut.put(recordId, { ...base, ...partial })
    },
    [stateMut, stateRecords, user?.id],
  )

  const markRead = useCallback(
    (conversationId: string) => {
      const conv = conversations.find((c) => c.recordId === conversationId)
      const msgCount = conv?.data.MessageCount ?? recentCreationsRef.current.get(conversationId)?.MessageCount ?? 0
      upsertState(conversationId, {
        LastReadAt: new Date().toISOString(),
        LastReadMessageCount: msgCount,
      })
    },
    [upsertState, conversations],
  )

  const toggleStar = useCallback(
    (conversationId: string) => {
      const isStarred = starredSet.has(conversationId)
      upsertState(conversationId, { Starred: isStarred ? 0 : 1 })
    },
    [upsertState, starredSet],
  )

  const setArchived = useCallback(
    (conversationId: string, archived: boolean) => {
      upsertState(conversationId, { Archived: archived ? 1 : 0 })
    },
    [upsertState],
  )

  const setTrashed = useCallback(
    (conversationId: string, trashed: boolean) => {
      upsertState(conversationId, { Trashed: trashed ? 1 : 0 })
    },
    [upsertState],
  )

  const setLabels = useCallback(
    (conversationId: string, labels: string[]) => {
      upsertState(conversationId, { Labels: JSON.stringify(labels) })
    },
    [upsertState],
  )

  const setFolder = useCallback(
    (conversationId: string, folder: string) => {
      upsertState(conversationId, { Folder: folder })
    },
    [upsertState],
  )

  return {
    conversations: conversations as RecordData<DirectoryConversationData>[],
    ready,
    createChannel,
    createDM,
    createGroupDM,
    lookupByName,
    updateLastMessage,
    readStateMap,
    readMessageCountMap,
    starredSet,
    archivedSet,
    getConversationState,
    upsertState,
    markRead,
    toggleStar,
    setArchived,
    setTrashed,
    setLabels,
    setFolder,
  }
}
