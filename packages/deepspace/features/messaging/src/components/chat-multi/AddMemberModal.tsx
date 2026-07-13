/**
 * AddMemberModal -- Invite users to a private group.
 * Creates invitation records (status: 'pending') that the invitee
 * must accept before becoming a member. Filters out current members
 * and users who already have a pending invitation.
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useUsers } from 'deepspace'
import { useUser } from 'deepspace'
import { useChannelMembers } from 'deepspace'
import { useMutations } from 'deepspace'
import { useQuery } from 'deepspace'
import type { ChannelInvitation } from 'deepspace'
import type { RecordData, RoomUser } from 'deepspace'

interface AddMemberModalProps {
  channelId: string
  onClose: () => void
}

export function AddMemberModal({ channelId, onClose }: AddMemberModalProps) {
  const { users } = useUsers()
  const { user: currentUser } = useUser()
  const { members } = useChannelMembers(channelId)
  const { create: createInvitation, put: updateInvitation } = useMutations<ChannelInvitation>('channel-invitations')
  const { records: allChannelInvitations } = useQuery<ChannelInvitation>('channel-invitations', {
    where: { channelId },
  })
  const [search, setSearch] = useState('')
  const [invitingUserId, setInvitingUserId] = useState<string | null>(null)
  const [justInvitedIds, setJustInvitedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const memberIds = useMemo(
    () => new Set(members.map((m) => m.data.userId)),
    [members]
  )

  const pendingInviteUserIds = useMemo(
    () => new Set(
      allChannelInvitations
        .filter((inv: RecordData<ChannelInvitation>) => inv.data.status === 'pending')
        .map((inv: RecordData<ChannelInvitation>) => inv.data.invitedUserId)
    ),
    [allChannelInvitations]
  )

  const availableUsers = useMemo(() => {
    const lowerSearch = search.toLowerCase()
    return users.filter(
      (u: RoomUser) =>
        u.id !== currentUser?.id &&
        !memberIds.has(u.id) &&
        !pendingInviteUserIds.has(u.id) &&
        !justInvitedIds.has(u.id) &&
        (lowerSearch === '' ||
          u.name?.toLowerCase().includes(lowerSearch) ||
          u.email?.toLowerCase().includes(lowerSearch))
    )
  }, [users, currentUser, memberIds, pendingInviteUserIds, justInvitedIds, search])

  const handleInvite = useCallback(
    async (userId: string) => {
      if (invitingUserId) return
      setInvitingUserId(userId)
      try {
        const existingDeclined = allChannelInvitations.find(
          (inv: RecordData<ChannelInvitation>) =>
            inv.data.invitedUserId === userId && inv.data.status === 'declined'
        )
        if (existingDeclined) {
          await updateInvitation(existingDeclined.recordId, {
            ...existingDeclined.data,
            status: 'pending',
          } as unknown as ChannelInvitation)
        } else {
          await createInvitation({
            channelId,
            invitedUserId: userId,
            status: 'pending',
          } as unknown as ChannelInvitation)
        }
        setJustInvitedIds((prev) => new Set(prev).add(userId))
      } finally {
        setInvitingUserId(null)
      }
    },
    [invitingUserId, createInvitation, updateInvitation, channelId, allChannelInvitations]
  )

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50 animate-in fade-in duration-150" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div
          data-testid="add-member-modal"
          className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md animate-in fade-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 pt-6 pb-0">
            <h2 className="text-lg font-semibold text-foreground">Invite Members</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Send an invitation to join this group. They'll need to accept before joining.
            </p>
          </div>

          <div className="px-6 pt-4 pb-2">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                data-testid="add-member-search"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email..."
                className="w-full bg-background border border-border rounded-lg pl-9 pr-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-shadow"
                autoFocus
              />
            </div>
          </div>

          <div className="px-3 pb-3 max-h-64 overflow-y-auto">
            <p className="text-xs text-muted-foreground px-3 pb-2">
              Only users who have visited the app are shown.
            </p>
            {availableUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {search
                  ? 'No matching users found'
                  : 'No users available to invite'}
              </p>
            ) : (
              <div className="py-1 space-y-0.5">
                {availableUsers.map((u: RoomUser) => (
                  <div
                    key={u.id}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/40 transition-colors"
                  >
                    {u.imageUrl ? (
                      <img src={u.imageUrl} alt="" className="w-9 h-9 rounded-full object-cover" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center text-sm font-semibold text-primary">
                        {u.name?.[0]?.toUpperCase() ?? '?'}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{u.name}</div>
                      {u.email && (
                        <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                      )}
                    </div>
                    <button
                      data-testid={`invite-member-${u.id}`}
                      onClick={() => handleInvite(u.id)}
                      disabled={invitingUserId === u.id}
                      className="shrink-0 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 transition-colors"
                    >
                      {invitingUserId === u.id ? 'Inviting...' : 'Invite'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="px-6 pb-6 pt-2 border-t border-border">
            <button
              onClick={onClose}
              className="w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg border border-border hover:bg-muted transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
