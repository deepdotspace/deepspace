/**
 * CreateGroupModal -- Create a new public or private group.
 * Name is normalized to lowercase-kebab. Description is optional.
 */

import { useState, useCallback, useEffect } from 'react'
import { useChannels } from 'deepspace'
import { useMutations } from 'deepspace'
import { useUser } from 'deepspace'
import type { ChannelMember } from 'deepspace'

interface CreateGroupModalProps {
  onClose: () => void
  onCreated: (channelId: string) => void
}

export function CreateGroupModal({ onClose, onCreated }: CreateGroupModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<'public' | 'private'>('public')
  const [isCreating, setIsCreating] = useState(false)
  const { create } = useChannels()
  const { create: createMembership } = useMutations<ChannelMember>('channel-members')
  const { user } = useUser()

  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const trimmedName = name.trim().toLowerCase().replace(/\s+/g, '-')
      if (!trimmedName || isCreating) return

      setIsCreating(true)
      try {
        const channelId = await create({
          name: trimmedName,
          type,
          description: description.trim(),
        })
        if (channelId && user) {
          await createMembership({
            channelId,
            userId: user.id,
            joinedAt: new Date().toISOString(),
          } as unknown as ChannelMember)
          onCreated(channelId)
        }
        onClose()
      } finally {
        setIsCreating(false)
      }
    },
    [name, description, type, isCreating, create, createMembership, user, onCreated, onClose]
  )

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50 animate-in fade-in duration-150" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div
          data-testid="create-group-modal"
          className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md animate-in fade-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-6 pt-6 pb-0">
            <h2 className="text-lg font-semibold text-foreground">Create a group</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Groups are where conversations happen around a topic.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="px-6 pt-5 pb-6">
            <div className="space-y-4">
              <div>
                <label htmlFor="group-name" className="block text-sm font-medium text-foreground mb-1.5">
                  Name
                </label>
                <input
                  id="group-name"
                  data-testid="group-name-input"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. design-team"
                  className="w-full bg-background border border-border rounded-lg px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-shadow"
                  autoFocus
                  maxLength={50}
                />
              </div>

              <div>
                <label htmlFor="group-desc" className="block text-sm font-medium text-foreground mb-1.5">
                  Description
                  <span className="text-muted-foreground font-normal ml-1">(optional)</span>
                </label>
                <input
                  id="group-desc"
                  data-testid="group-description-input"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What's this group about?"
                  className="w-full bg-background border border-border rounded-lg px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-shadow"
                  maxLength={120}
                />
              </div>

              <fieldset>
                <legend className="block text-sm font-medium text-foreground mb-2">Visibility</legend>
                <div className="grid grid-cols-2 gap-2">
                  <label
                    className={`flex items-center gap-2.5 px-3.5 py-3 rounded-lg border cursor-pointer transition-all ${
                      type === 'public'
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                        : 'border-border hover:border-muted-foreground/30'
                    }`}
                  >
                    <input
                      type="radio"
                      name="group-type"
                      value="public"
                      checked={type === 'public'}
                      onChange={() => setType('public')}
                      className="sr-only"
                    />
                    <svg className={`w-4 h-4 shrink-0 ${type === 'public' ? 'text-primary' : 'text-muted-foreground'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <span className="text-sm font-medium text-foreground block">Public</span>
                      <span className="text-xs text-muted-foreground">Anyone can join</span>
                    </div>
                  </label>
                  <label
                    className={`flex items-center gap-2.5 px-3.5 py-3 rounded-lg border cursor-pointer transition-all ${
                      type === 'private'
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                        : 'border-border hover:border-muted-foreground/30'
                    }`}
                  >
                    <input
                      type="radio"
                      name="group-type"
                      value="private"
                      checked={type === 'private'}
                      onChange={() => setType('private')}
                      className="sr-only"
                    />
                    <svg className={`w-4 h-4 shrink-0 ${type === 'private' ? 'text-primary' : 'text-muted-foreground'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    <div>
                      <span className="text-sm font-medium text-foreground block">Private</span>
                      <span className="text-xs text-muted-foreground">Invite only</span>
                    </div>
                  </label>
                </div>
              </fieldset>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg border border-border hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                data-testid="create-group-submit"
                type="submit"
                disabled={!name.trim() || isCreating}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isCreating ? 'Creating...' : 'Create Group'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
