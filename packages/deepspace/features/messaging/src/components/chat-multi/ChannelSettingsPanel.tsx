/**
 * ChannelSettingsPanel -- View/edit group info, manage members, leave.
 * Renders as a slide-over panel on the right side of the chat.
 *
 * Permissions:
 * - Public groups: no invite button (users join via Browse Groups)
 * - Private groups: only the creator can invite others (invitation-based)
 */

import { useState, useCallback, useMemo } from 'react'
import { useChannels } from 'deepspace'
import { useChannelMembers } from 'deepspace'
import { useUser } from 'deepspace'
import { useUserLookup } from 'deepspace'
import { useQuery } from 'deepspace'
import type { Channel, ChannelInvitation } from 'deepspace'
import type { RecordData } from 'deepspace'
import { AddMemberModal } from './AddMemberModal'

interface ChannelSettingsPanelProps {
  channelId: string
  onClose: () => void
  onLeave: () => void
}

export function ChannelSettingsPanel({ channelId, onClose, onLeave }: ChannelSettingsPanelProps) {
  const { channels, update } = useChannels()
  const { members, leave } = useChannelMembers(channelId)
  const { user } = useUser()
  const { getUser } = useUserLookup()
  const [showAddMember, setShowAddMember] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const channel = channels.find((c: RecordData<Channel>) => c.recordId === channelId)
  const isCreator = channel?.createdBy === user?.id
  const isPrivate = channel?.data.type === 'private'
  const canInvite = isPrivate && isCreator

  const { records: channelInvitations } = useQuery<ChannelInvitation>('channel-invitations', {
    where: { channelId },
  })
  const pendingInvites = useMemo(
    () => channelInvitations.filter(
      (inv: RecordData<ChannelInvitation>) => inv.data.status === 'pending'
    ),
    [channelInvitations]
  )

  const sortedMembers = useMemo(
    () =>
      [...members].sort((a, b) => {
        const aUser = getUser(a.data.userId)
        const bUser = getUser(b.data.userId)
        return (aUser?.name ?? '').localeCompare(bUser?.name ?? '')
      }),
    [members, getUser]
  )

  const handleLeave = useCallback(async () => {
    await leave()
    onLeave()
  }, [leave, onLeave])

  const startEditing = useCallback(() => {
    if (!channel) return
    setEditName(channel.data.name)
    setEditDescription(channel.data.description ?? '')
    setIsEditing(true)
  }, [channel])

  const cancelEditing = useCallback(() => {
    setIsEditing(false)
  }, [])

  const saveEditing = useCallback(async () => {
    if (!channel || isSaving) return
    const trimmedName = editName.trim().toLowerCase().replace(/\s+/g, '-')
    if (!trimmedName) return

    setIsSaving(true)
    try {
      await update(channelId, {
        name: trimmedName,
        description: editDescription.trim(),
      })
      setIsEditing(false)
    } finally {
      setIsSaving(false)
    }
  }, [channel, isSaving, editName, editDescription, update, channelId])

  if (!channel) return null

  return (
    <>
      <div
        data-testid="channel-settings-panel"
        className="w-full md:w-80 border-l border-border flex flex-col h-full bg-card shrink-0"
      >
        {/* Header */}
        <div className="shrink-0 h-12 border-b border-border px-4 flex items-center justify-between">
          <h3 className="font-semibold text-sm text-foreground">Group Info</h3>
          <button
            data-testid="close-settings-btn"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Channel info */}
          <div className="px-4 py-5">
            {isEditing ? (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Group name
                  </label>
                  <input
                    data-testid="edit-channel-name"
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEditing()
                      if (e.key === 'Escape') cancelEditing()
                    }}
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-shadow"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">
                    Description
                  </label>
                  <textarea
                    data-testid="edit-channel-description"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') cancelEditing()
                    }}
                    rows={2}
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-shadow resize-none"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    data-testid="save-channel-edit"
                    onClick={saveEditing}
                    disabled={isSaving || !editName.trim()}
                    className="flex-1 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 transition-colors"
                  >
                    {isSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    data-testid="cancel-channel-edit"
                    onClick={cancelEditing}
                    disabled={isSaving}
                    className="flex-1 px-3 py-1.5 text-xs font-medium text-muted-foreground border border-border rounded-lg hover:bg-muted transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    {isPrivate ? (
                      <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-base font-semibold text-foreground truncate">
                      {channel.data.name}
                    </h4>
                    <span className="text-xs text-muted-foreground capitalize">
                      {channel.data.type} group
                    </span>
                  </div>
                  {isCreator && (
                    <button
                      data-testid="edit-channel-btn"
                      onClick={startEditing}
                      className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      title="Edit group"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                  )}
                </div>
                {channel.data.description && (
                  <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                    {channel.data.description}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="h-px bg-border mx-4" />

          {/* Members section */}
          <div className="px-4 py-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-foreground">
                Members
                <span className="text-muted-foreground font-normal ml-1.5">
                  {members.length}
                </span>
              </h4>
              {canInvite && (
                <button
                  data-testid="add-member-btn"
                  onClick={() => setShowAddMember(true)}
                  className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  Invite member
                </button>
              )}
            </div>

            <div className="space-y-0.5">
              {sortedMembers.map((m) => {
                const memberUser = getUser(m.data.userId)
                const isCurrentUser = m.data.userId === user?.id
                const isMemberCreator = m.data.userId === channel.createdBy

                return (
                  <div
                    key={m.recordId}
                    className="flex items-center gap-2.5 px-2 py-2 rounded-lg"
                  >
                    {memberUser?.imageUrl ? (
                      <img src={memberUser.imageUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center text-xs font-semibold text-primary">
                        {(memberUser?.name ?? '?')[0]?.toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-foreground truncate block">
                        {memberUser?.name ?? 'Unknown'}
                        {isCurrentUser && (
                          <span className="text-muted-foreground ml-1">(you)</span>
                        )}
                      </span>
                    </div>
                    {isMemberCreator && (
                      <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        Creator
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Pending invitations (private groups only) */}
          {isPrivate && pendingInvites.length > 0 && (
            <>
              <div className="h-px bg-border mx-4" />
              <div className="px-4 py-4">
                <h4 className="text-sm font-semibold text-foreground mb-3">
                  Pending Invitations
                  <span className="text-muted-foreground font-normal ml-1.5">
                    {pendingInvites.length}
                  </span>
                </h4>
                <div className="space-y-0.5">
                  {pendingInvites.map((inv: RecordData<ChannelInvitation>) => {
                    const invitedUser = getUser(inv.data.invitedUserId)
                    return (
                      <div
                        key={inv.recordId}
                        className="flex items-center gap-2.5 px-2 py-2 rounded-lg"
                      >
                        {invitedUser?.imageUrl ? (
                          <img src={invitedUser.imageUrl} alt="" className="w-8 h-8 rounded-full object-cover opacity-60" />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground">
                            {(invitedUser?.name ?? '?')[0]?.toUpperCase()}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-muted-foreground truncate block">
                            {invitedUser?.name ?? 'Unknown'}
                          </span>
                        </div>
                        <span className="text-[10px] font-medium text-warning bg-warning/10 px-1.5 py-0.5 rounded">
                          Pending
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          <div className="h-px bg-border mx-4" />

          {/* Leave group */}
          <div className="px-4 py-4">
            <button
              data-testid="leave-group-btn"
              onClick={handleLeave}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-destructive hover:bg-destructive/10 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Leave group
            </button>
          </div>
        </div>
      </div>

      {showAddMember && (
        <AddMemberModal
          channelId={channelId}
          onClose={() => setShowAddMember(false)}
        />
      )}
    </>
  )
}
