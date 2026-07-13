import { useMemo, useState } from 'react'

export interface DocsPresenceParticipant {
  clientId: number
  userId: string
  name: string
  email?: string
  imageUrl?: string
  mode: 'edit' | 'view'
  typing?: boolean
  lastTypedAt?: number
  isSelf?: boolean
}

export interface DocsPresenceProps {
  participants: DocsPresenceParticipant[]
  typingNames: string[]
}

const MAX_VISIBLE_AVATARS = 3

/** Stable React keys (Yjs clientId is not used for PresenceRoom peers). */
function participantKey(p: DocsPresenceParticipant) {
  return `${p.userId}:${p.isSelf ? 'self' : 'peer'}`
}

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return (parts[0]?.slice(0, 2) || '?').toUpperCase()
}

function typingText(names: string[]) {
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is typing...`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more are typing...`
}

function ParticipantAvatar({ participant, index }: { participant: DocsPresenceParticipant; index: number }) {
  const label = `${participant.name}${participant.isSelf ? ' (you)' : ''} - ${
    participant.mode === 'edit' ? 'Editing' : 'Viewing'
  }`

  return (
    <span
      className="docs-presence-avatar"
      style={{ zIndex: 20 - index }}
      title={label}
      aria-label={label}
    >
      {participant.imageUrl ? (
        <img src={participant.imageUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden>{initialsFor(participant.name)}</span>
      )}
    </span>
  )
}

export function DocsPresence({ participants, typingNames }: DocsPresenceProps) {
  const [open, setOpen] = useState(false)
  const visibleParticipants = participants.slice(0, MAX_VISIBLE_AVATARS)
  const hiddenCount = Math.max(0, participants.length - MAX_VISIBLE_AVATARS)
  const message = typingText(typingNames)

  const heading = useMemo(() => {
    const count = participants.length
    if (count === 0) return 'No active viewers'
    if (count === 1) return '1 person here'
    return `${count} people here`
  }, [participants.length])

  return (
    <div className="relative flex shrink-0 items-center gap-2" data-testid="docs-presence">
      {message ? (
        <span
          className="hidden max-w-[220px] truncate text-xs sm:inline"
          style={{ color: 'var(--docs-el-muted)' }}
          data-testid="docs-typing-indicator"
        >
          {message}
        </span>
      ) : null}

      <div className="flex items-center -space-x-2" aria-label={heading}>
        {visibleParticipants.map((participant, index) => (
          <ParticipantAvatar key={participantKey(participant)} participant={participant} index={index} />
        ))}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="docs-presence-more"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={`View ${hiddenCount} more collaborator${hiddenCount === 1 ? '' : 's'}`}
            data-testid="docs-presence-more"
          >
            +{hiddenCount}
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          className="absolute right-0 top-9 z-50 w-64 rounded-xl border p-2 shadow-xl"
          style={{
            borderColor: 'var(--docs-el-line)',
            backgroundColor: 'var(--docs-el-surface)',
            color: 'var(--docs-el-text)',
          }}
          data-testid="docs-presence-popover"
        >
          <p className="px-2 pb-2 text-xs font-medium" style={{ color: 'var(--docs-el-muted)' }}>
            {heading}
          </p>
          <ul className="max-h-72 overflow-y-auto">
            {participants.map((participant) => (
              <li key={participantKey(participant)} className="flex items-center gap-2 rounded-lg px-2 py-2">
                <ParticipantAvatar participant={participant} index={0} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {participant.name}
                    {participant.isSelf ? ' (you)' : ''}
                  </p>
                  <p className="truncate text-xs" style={{ color: 'var(--docs-el-muted)' }}>
                    {participant.mode === 'edit' ? 'Editing' : 'Viewing'}
                    {participant.typing ? ' - typing' : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
