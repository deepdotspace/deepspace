/**
 * ChatHeader -- Channel header showing name, description, and member count.
 * Generic styling (no Slack-specific prefixes like #).
 */

import { useChannels } from 'deepspace'
import { useChannelMembers } from 'deepspace'
import type { Channel } from 'deepspace'
import type { RecordData } from 'deepspace'

interface ChatHeaderProps {
  channelId: string
  onToggleThread?: () => void
  threadOpen?: boolean
}

export function ChatHeader({ channelId, onToggleThread, threadOpen }: ChatHeaderProps) {
  const { channels } = useChannels()
  const { members } = useChannelMembers(channelId)

  const channel = channels.find((c: RecordData<Channel>) => c.recordId === channelId)

  return (
    <div
      data-testid="chat-header"
      className="shrink-0 px-4 py-3 border-b border-border bg-card/80 backdrop-blur-sm flex items-center justify-between gap-3"
    >
      <div className="flex items-center gap-3 min-w-0">
        <h1
          className="text-base font-semibold text-foreground truncate"
          data-testid="chat-header-name"
        >
          {channel?.data.name ?? 'Chat'}
        </h1>
        {channel?.data.description && (
          <>
            <div className="w-px h-4 bg-border shrink-0" />
            <span className="text-sm text-muted-foreground truncate">
              {channel.data.description}
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <span
          className="text-xs text-muted-foreground"
          data-testid="chat-header-member-count"
        >
          {members.length} {members.length === 1 ? 'member' : 'members'}
        </span>
        {onToggleThread && (
          <button
            data-testid="toggle-thread-btn"
            onClick={onToggleThread}
            className={`p-1.5 rounded-md transition-colors ${
              threadOpen
                ? 'text-primary bg-primary/10'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
            title="Threads"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
