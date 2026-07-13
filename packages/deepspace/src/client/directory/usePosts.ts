/**
 * usePosts Hook
 *
 * CRUD operations for the `posts` collection in the dir:{appName} DO.
 *
 * Apps that need feeds, Q&A, or tweet-style content should:
 * 1. Add { type: 'dir', instanceId: APP_ID } to SHARED_CONNECTIONS.
 * 2. Call usePosts() inside a RecordProvider.
 */

import { useCallback } from 'react'
import { useQuery } from '../storage/hooks/useQuery'
import { useMutations } from '../storage/hooks/useMutations'
import { useUser } from '../storage/hooks/useUser'
import type { RecordData } from '../storage/types'
import type { DirectoryPostData } from '../../shared/types'

export function usePosts(opts?: { communityId?: string }) {
  const { records: allPosts, status } = useQuery<DirectoryPostData>('posts')
  const postMut = useMutations<DirectoryPostData>('posts')
  const { user } = useUser()

  const ready = status === 'ready'

  const posts = opts?.communityId
    ? allPosts.filter((p) => p.data.CommunityId === opts.communityId)
    : allPosts

  const createPost = useCallback(
    async (data: {
      title: string
      content: string
      type?: string
      communityId?: string
      parentId?: string
      tags?: string[]
      linkUrl?: string
    }) => {
      const recordId = await postMut.create({
        Title: data.title,
        Content: data.content,
        AuthorId: user?.id ?? '',
        Type: data.type ?? 'post',
        CommunityId: data.communityId ?? '',
        ParentId: data.parentId ?? '',
        ConversationId: '',
        Status: 'published',
        Tags: data.tags ? JSON.stringify(data.tags) : '',
        LinkUrl: data.linkUrl ?? '',
      })
      return recordId
    },
    [postMut, user?.id],
  )

  const updatePost = useCallback(
    (postId: string, updates: Partial<DirectoryPostData>) => {
      const existing = allPosts.find((p) => p.recordId === postId)
      if (!existing) return
      postMut.put(postId, { ...existing.data, ...updates })
    },
    [postMut, allPosts],
  )

  const deletePost = useCallback(
    (postId: string) => {
      postMut.remove(postId)
    },
    [postMut],
  )

  const setConversationId = useCallback(
    (postId: string, conversationId: string) => {
      updatePost(postId, { ConversationId: conversationId })
    },
    [updatePost],
  )

  return {
    posts: posts as RecordData<DirectoryPostData>[],
    ready,
    createPost,
    updatePost,
    deletePost,
    setConversationId,
  }
}
