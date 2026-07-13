/**
 * useCommunities Hook
 *
 * CRUD operations for the `communities` and `memberships` collections
 * in the dir:{appName} DO.
 *
 * Apps that need forums, groups, or boards should:
 * 1. Add { type: 'dir', instanceId: APP_ID } to SHARED_CONNECTIONS.
 * 2. Call useCommunities() inside a RecordProvider.
 */

import { useCallback, useMemo } from 'react'
import { useQuery } from '../storage/hooks/useQuery'
import { useMutations } from '../storage/hooks/useMutations'
import { useUser } from '../storage/hooks/useUser'
import type { RecordData } from '../storage/types'
import type { DirectoryCommunityData, DirectoryMembershipData } from '../../shared/types'

export function useCommunities() {
  const { records: communities, status } = useQuery<DirectoryCommunityData>('communities')
  const communityMut = useMutations<DirectoryCommunityData>('communities')
  const { records: memberships } = useQuery<DirectoryMembershipData>('memberships')
  const membershipMut = useMutations<DirectoryMembershipData>('memberships')
  const { user } = useUser()

  const ready = status === 'ready'

  const membershipMap = useMemo(() => {
    const map = new Map<string, DirectoryMembershipData[]>()
    for (const m of memberships) {
      const list = map.get(m.data.CommunityId) ?? []
      list.push(m.data)
      map.set(m.data.CommunityId, list)
    }
    return map
  }, [memberships])

  const myMemberships = useMemo(
    () => new Set(
      memberships
        .filter((m) => m.data.UserId === user?.id)
        .map((m) => m.data.CommunityId),
    ),
    [memberships, user?.id],
  )

  const createCommunity = useCallback(
    async (name: string, opts?: { description?: string; type?: string; visibility?: string; rules?: string }) => {
      const existing = communities.find((c) => c.data.Name === name)
      if (existing) return existing.recordId

      const recordId = await communityMut.create({
        Name: name,
        Description: opts?.description ?? '',
        CreatedBy: user?.id ?? '',
        Type: opts?.type ?? 'community',
        Visibility: opts?.visibility ?? 'public',
        MemberCount: 0,
        Rules: opts?.rules ?? '',
        IconUrl: '',
        CoverUrl: '',
      })
      return recordId
    },
    [communityMut, user?.id, communities],
  )

  const updateCommunity = useCallback(
    (communityId: string, updates: Partial<DirectoryCommunityData>) => {
      const existing = communities.find((c) => c.recordId === communityId)
      if (!existing) return
      communityMut.put(communityId, { ...existing.data, ...updates })
    },
    [communityMut, communities],
  )

  const joinCommunity = useCallback(
    async (communityId: string, userName: string) => {
      if (!user?.id) return null
      const existing = memberships.find(
        (m) => m.data.CommunityId === communityId && m.data.UserId === user.id,
      )
      if (existing) return existing.recordId

      const recordId = await membershipMut.create({
        CommunityId: communityId,
        UserId: user.id,
        UserName: userName,
        Role: 'member',
        JoinedAt: new Date().toISOString(),
      })
      return recordId
    },
    [membershipMut, memberships, user?.id],
  )

  const leaveCommunity = useCallback(
    (communityId: string) => {
      if (!user?.id) return
      const membership = memberships.find(
        (m) => m.data.CommunityId === communityId && m.data.UserId === user.id,
      )
      if (membership) {
        membershipMut.remove(membership.recordId)
      }
    },
    [membershipMut, memberships, user?.id],
  )

  const getMembersOf = useCallback(
    (communityId: string): DirectoryMembershipData[] => {
      return membershipMap.get(communityId) ?? []
    },
    [membershipMap],
  )

  const lookupByName = useCallback(
    (name: string) => {
      const found = communities.find((c) => c.data.Name === name)
      return found?.recordId ?? null
    },
    [communities],
  )

  return {
    communities: communities as RecordData<DirectoryCommunityData>[],
    memberships: memberships as RecordData<DirectoryMembershipData>[],
    ready,
    myMemberships,
    createCommunity,
    updateCommunity,
    joinCommunity,
    leaveCommunity,
    getMembersOf,
    lookupByName,
  }
}
