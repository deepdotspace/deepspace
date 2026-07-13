/**
 * BrowseGroupsModal -- Discover and join public groups.
 * Shows a searchable list of public channels with join/open actions.
 */

import { useState, useEffect } from 'react'
import { useChannels } from 'deepspace'
import { useChannelMembers } from 'deepspace'
import type { Channel } from 'deepspace'
import type { RecordData } from 'deepspace'

interface BrowseGroupsModalProps {
  onClose: () => void
  onSelected: (channelId: string) => void
}

export function BrowseGroupsModal({ onClose, onSelected }: BrowseGroupsModalProps) {
  const { channels } = useChannels()
  const [search, setSearch] = useState('')

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const publicGroups = channels.filter(
    (c: RecordData<Channel>) =>
      c.data.type === 'public' &&
      !c.data.archived &&
      c.data.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50 animate-in fade-in duration-150" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div
          data-testid="browse-groups-modal"
          className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg animate-in fade-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 pt-6 pb-0">
            <h2 className="text-lg font-semibold text-foreground">Browse Groups</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Discover public groups and join the conversation.
            </p>
          </div>

          <div className="px-6 pt-4 pb-2">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                data-testid="browse-search-input"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search groups..."
                className="w-full bg-background border border-border rounded-lg pl-9 pr-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-shadow"
                autoFocus
              />
            </div>
          </div>

          <div className="px-3 pb-3 max-h-80 overflow-y-auto">
            {publicGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {search ? 'No groups found' : 'No public groups yet'}
              </p>
            ) : (
              <div className="py-1 space-y-1">
                {publicGroups.map((ch: RecordData<Channel>) => (
                  <BrowseGroupRow
                    key={ch.recordId}
                    channel={ch}
                    onSelect={() => onSelected(ch.recordId)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="px-6 pb-6 pt-2 border-t border-border">
            <button
              onClick={onClose}
              className="w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg border border-border hover:bg-muted transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function BrowseGroupRow({
  channel,
  onSelect,
}: {
  channel: RecordData<Channel>
  onSelect: () => void
}) {
  const { members, isMember, join, status } = useChannelMembers(channel.recordId)
  const [joining, setJoining] = useState(false)

  const handleJoin = async () => {
    setJoining(true)
    try {
      await join()
      onSelect()
    } finally {
      setJoining(false)
    }
  }

  const loading = status !== 'ready'

  return (
    <div
      data-testid={`browse-group-${channel.data.name}`}
      className="flex items-center gap-3 px-3 py-3 rounded-lg hover:bg-muted/40 transition-colors"
    >
      <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
        <svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{channel.data.name}</div>
        {channel.data.description && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">{channel.data.description}</div>
        )}
        <div className="text-xs text-muted-foreground mt-0.5">
          {members.length} {members.length === 1 ? 'member' : 'members'}
        </div>
      </div>
      {loading ? (
        <span className="shrink-0 px-3 py-1.5 text-xs text-muted-foreground">...</span>
      ) : isMember ? (
        <button
          onClick={onSelect}
          className="shrink-0 px-3 py-1.5 text-xs font-medium bg-muted text-foreground rounded-lg border border-border hover:bg-muted/80 transition-colors"
        >
          Open
        </button>
      ) : (
        <button
          data-testid={`join-group-${channel.data.name}`}
          onClick={handleJoin}
          disabled={joining}
          className="shrink-0 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 transition-colors"
        >
          {joining ? 'Joining...' : 'Join'}
        </button>
      )}
    </div>
  )
}
