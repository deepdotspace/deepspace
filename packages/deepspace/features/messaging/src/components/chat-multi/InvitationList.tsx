/**
 * InvitationList -- Inline list of pending group invitations.
 * Shown in the sidebar when the user has pending invitations.
 * Accept joins the channel + updates invitation status.
 * Decline updates the invitation status to 'declined'.
 */

import { useState, useCallback } from 'react'
import { useChannelMembers } from 'deepspace'
import { useMutations } from 'deepspace'
import { useUserLookup } from 'deepspace'
import type { Channel, ChannelInvitation } from 'deepspace'
import type { RecordData } from 'deepspace'

interface PendingInvitation {
  invitation: RecordData<ChannelInvitation>
  channel: RecordData<Channel> | undefined
}

interface InvitationListProps {
  invitations: PendingInvitation[]
  onAccepted: (channelId: string) => void
}

export function InvitationList({ invitations, onAccepted }: InvitationListProps) {
  if (invitations.length === 0) return null

  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 px-2 py-2">
        <svg
          className="w-3.5 h-3.5 text-warning"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
        <span className="text-[11px] font-bold text-muted-foreground/70 uppercase tracking-widest">
          Invitations
        </span>
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-warning/15 text-warning text-[10px] font-bold tabular-nums">
          {invitations.length}
        </span>
      </div>
      <div className="space-y-1.5 px-0.5">
        {invitations.map(({ invitation, channel }) => (
          <InvitationRow
            key={invitation.recordId}
            invitation={invitation}
            channel={channel}
            onAccepted={onAccepted}
          />
        ))}
      </div>
    </div>
  )
}

function InvitationRow({
  invitation,
  channel,
  onAccepted,
}: {
  invitation: RecordData<ChannelInvitation>
  channel: RecordData<Channel> | undefined
  onAccepted: (channelId: string) => void
}) {
  const { join } = useChannelMembers(invitation.data.channelId)
  const { put } = useMutations<ChannelInvitation>('channel-invitations')
  const { getUser } = useUserLookup()
  const [acting, setActing] = useState<'accept' | 'decline' | null>(null)

  const inviter = getUser(invitation.data.invitedBy)
  const channelName = channel?.data.name ?? 'Unknown group'
  const isPrivate = channel?.data.type === 'private'

  const handleAccept = useCallback(async () => {
    setActing('accept')
    try {
      await put(invitation.recordId, {
        ...invitation.data,
        status: 'accepted',
      } as unknown as ChannelInvitation)
      await join()
      onAccepted(invitation.data.channelId)
    } finally {
      setActing(null)
    }
  }, [invitation, put, join, onAccepted])

  const handleDecline = useCallback(async () => {
    setActing('decline')
    try {
      await put(invitation.recordId, {
        ...invitation.data,
        status: 'declined',
      } as unknown as ChannelInvitation)
    } finally {
      setActing(null)
    }
  }, [invitation, put])

  return (
    <div
      data-testid={`invitation-${invitation.recordId}`}
      className="px-3 py-3 rounded-xl bg-warning/5 border border-warning/10"
    >
      <div className="flex items-center gap-2.5 mb-2">
        <span className="shrink-0 w-8 h-8 rounded-lg bg-warning/10 flex items-center justify-center">
          {isPrivate ? (
            <svg className="w-3.5 h-3.5 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{channelName}</p>
          <p className="text-[11px] text-muted-foreground/70">
            from {inviter?.name ?? 'someone'}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <button
          data-testid={`accept-invitation-${invitation.recordId}`}
          onClick={handleAccept}
          disabled={acting !== null}
          className="flex-1 px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 active:bg-primary/80 disabled:opacity-40 transition-colors duration-200 cursor-pointer"
        >
          {acting === 'accept' ? 'Joining...' : 'Accept'}
        </button>
        <button
          data-testid={`decline-invitation-${invitation.recordId}`}
          onClick={handleDecline}
          disabled={acting !== null}
          className="flex-1 px-3 py-1.5 text-xs font-semibold text-muted-foreground border border-border/60 rounded-lg hover:bg-muted/50 active:bg-muted disabled:opacity-40 transition-colors duration-200 cursor-pointer"
        >
          {acting === 'decline' ? 'Declining...' : 'Decline'}
        </button>
      </div>
    </div>
  )
}
