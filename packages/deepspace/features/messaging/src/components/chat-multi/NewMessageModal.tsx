/**
 * NewMessageModal -- Start a direct message with another user.
 * Finds existing DM channels to avoid duplicates.
 */

import { useState, useCallback, useEffect } from 'react'
import { useUser } from 'deepspace'
import { useUsers } from 'deepspace'
import { useChannels } from 'deepspace'
import { useMutations } from 'deepspace'
import type { Channel, ChannelMember } from 'deepspace'
import type { RecordData } from 'deepspace'

interface NewMessageModalProps {
  onClose: () => void
  onSelected: (channelId: string) => void
}

export function NewMessageModal({ onClose, onSelected }: NewMessageModalProps) {
  const { user } = useUser()
  const { users } = useUsers()
  const { channels, create } = useChannels()
  const { create: createMembership } = useMutations<ChannelMember>('channel-members')
  const [search, setSearch] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const filteredUsers = users.filter(
    (u) =>
      u.id !== user?.id &&
      (u.name?.toLowerCase().includes(search.toLowerCase()) ||
        u.email?.toLowerCase().includes(search.toLowerCase()))
  )

  const handleSelectUser = useCallback(
    async (targetUserId: string, targetName: string) => {
      if (!user || isCreating) return

      const ids = [user.id, targetUserId].sort()
      const dmChannelName = `dm-${ids[0]}-${ids[1]}`

      const existingDM = channels.find(
        (c: RecordData<Channel>) => c.data.type === 'dm' && c.data.name === dmChannelName
      )

      if (existingDM) {
        onSelected(existingDM.recordId)
        onClose()
        return
      }

      setIsCreating(true)
      try {
        const channelId = await create({
          name: dmChannelName,
          type: 'dm',
          description: targetName,
        })
        if (channelId && user) {
          await createMembership({
            channelId,
            userId: user.id,
            joinedAt: new Date().toISOString(),
          } as unknown as ChannelMember)
          onSelected(channelId)
        }
        onClose()
      } finally {
        setIsCreating(false)
      }
    },
    [user, isCreating, channels, create, createMembership, onSelected, onClose]
  )

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50 animate-in fade-in duration-150" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div
          data-testid="new-message-modal"
          className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md animate-in fade-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 pt-6 pb-0">
            <h2 className="text-lg font-semibold text-foreground">New Message</h2>
            <p className="text-sm text-muted-foreground mt-1">Send a direct message to someone.</p>
          </div>

          <div className="px-6 pt-4 pb-2">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                data-testid="dm-search-input"
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
            {filteredUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {search ? 'No users found' : 'No other users available'}
              </p>
            ) : (
              <div className="py-1 space-y-0.5">
                {filteredUsers.map((u) => (
                  <button
                    key={u.id}
                    data-testid={`dm-user-${u.id}`}
                    onClick={() => handleSelectUser(u.id, u.name)}
                    disabled={isCreating}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/60 text-left transition-colors disabled:opacity-50"
                  >
                    {u.imageUrl ? (
                      <img src={u.imageUrl} alt="" className="w-9 h-9 rounded-full object-cover" />
                    ) : (
                      <div className="w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center text-sm font-semibold text-primary">
                        {u.name?.[0]?.toUpperCase() ?? '?'}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground truncate">{u.name}</div>
                      {u.email && (
                        <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="px-6 pb-6 pt-2 border-t border-border">
            <button
              onClick={onClose}
              className="w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg border border-border hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
