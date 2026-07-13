import { useMemo, useState } from 'react'
import type { RecordData } from 'deepspace'
import { useMutations, useQuery, useUser } from 'deepspace'
import { Mail, ShieldCheck, UserMinus, Users } from 'lucide-react'
import { Modal, useToast } from '@/components/ui'

export interface InviteDialogDocumentFields {
  title: string
  ownerId: string
  collaborators?: string
  editors?: string
  folderId?: string
}

interface UserFields {
  email?: string
  name?: string
  imageUrl?: string
}

type InviteRole = 'viewer' | 'editor'

/**
 * Diff that resulted from an InviteDialog save. The editor page rebroadcasts
 * this over the doc's presence channel so the affected peer gets the change
 * even when the docs schema's `read: 'collaborator'` rule prevents the
 * `documents` record update from reaching a now-removed user.
 */
export interface InviteAclDiff {
  /** Users dropped from `collaborators` entirely. */
  removedUserIds: string[]
  /** Users who lost the editor role but remain collaborators (now viewers). */
  demotedUserIds: string[]
  /** Existing collaborators who gained the editor role. */
  promotedUserIds: string[]
}

interface InviteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  doc: RecordData<InviteDialogDocumentFields>
  isOwner: boolean
  /**
   * Called after a save mutation that changed the ACL. The parent uses it to
   * publish a one-shot permission-change signal over the doc's presence room
   * so peers (including ones who just lost read access to the doc record)
   * can react immediately instead of waiting for the next refresh.
   */
  onAclChange?: (diff: InviteAclDiff) => void
}

function parseIds(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))]
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

export function InviteDialog({ open, onOpenChange, doc, isOwner, onAclChange }: InviteDialogProps) {
  const { user } = useUser()
  const { records: users } = useQuery<UserFields>('users')
  const { put } = useMutations<InviteDialogDocumentFields>('documents')
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InviteRole>('editor')
  const [saving, setSaving] = useState(false)

  const collaborators = useMemo(() => parseIds(doc.data.collaborators), [doc.data.collaborators])
  const editors = useMemo(() => parseIds(doc.data.editors), [doc.data.editors])

  const ownerRecord = useMemo(
    () => users.find((u) => u.recordId === doc.data.ownerId),
    [doc.data.ownerId, users],
  )

  const collaboratorRecords = useMemo(
    () =>
      collaborators
        .map((id) => users.find((u) => u.recordId === id))
        .filter((u): u is RecordData<UserFields> => Boolean(u)),
    [collaborators, users],
  )

  if (!isOwner) return null

  const saveAccess = async (nextCollaborators: string[], nextEditors: string[]) => {
    const prevCollaborators = parseIds(doc.data.collaborators)
    const prevEditors = parseIds(doc.data.editors)
    const nextCollabList = uniqueIds(nextCollaborators)
    const nextCollabSet = new Set(nextCollabList)
    const nextEditorList = uniqueIds(nextEditors).filter((id) => nextCollabSet.has(id))
    const nextEditorSet = new Set(nextEditorList)

    setSaving(true)
    try {
      await put(doc.recordId, {
        ...doc.data,
        collaborators: JSON.stringify(nextCollabList),
        editors: JSON.stringify(nextEditorList),
      })

      if (onAclChange) {
        const removedUserIds = prevCollaborators.filter((id) => !nextCollabSet.has(id))
        const demotedUserIds = prevEditors.filter(
          (id) => nextCollabSet.has(id) && !nextEditorSet.has(id),
        )
        const promotedUserIds = nextEditorList.filter(
          (id) => prevCollaborators.includes(id) && !prevEditors.includes(id),
        )
        if (removedUserIds.length || demotedUserIds.length || promotedUserIds.length) {
          onAclChange({ removedUserIds, demotedUserIds, promotedUserIds })
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const addInvite = async () => {
    const normalized = email.trim().toLowerCase()
    if (!normalized) return

    const target = users.find((u) => u.data.email?.trim().toLowerCase() === normalized)
    if (!target) {
      toast.error('User not found', 'No DeepSpace user with that email has used this app yet.')
      return
    }
    if (target.recordId === doc.data.ownerId || target.recordId === user?.id) {
      toast.info('Already has access', 'That user is the document owner.')
      return
    }
    if (collaborators.includes(target.recordId)) {
      toast.info('Already invited', `${target.data.email ?? normalized} already has access.`)
      return
    }

    const nextCollaborators = [...collaborators, target.recordId]
    const nextEditors = role === 'editor' ? [...editors, target.recordId] : editors
    await saveAccess(nextCollaborators, nextEditors)
    setEmail('')
    toast.success('Invite added', `${target.data.email ?? normalized} now has ${role} access.`)
  }

  const setCollaboratorRole = async (userId: string, nextRole: InviteRole) => {
    const nextEditors =
      nextRole === 'editor'
        ? uniqueIds([...editors, userId])
        : editors.filter((id) => id !== userId)
    await saveAccess(collaborators, nextEditors)
  }

  const removeCollaborator = async (userId: string) => {
    await saveAccess(
      collaborators.filter((id) => id !== userId),
      editors.filter((id) => id !== userId),
    )
  }

  const ownerName =
    ownerRecord?.data.name?.trim() ||
    ownerRecord?.data.email?.trim() ||
    user?.name ||
    user?.email ||
    'Owner'

  return (
    <Modal open={open} onClose={() => onOpenChange(false)} size="lg" className="docs-feature-scope">
      <Modal.Header onClose={() => onOpenChange(false)}>
        <Modal.Title>Share document</Modal.Title>
        <Modal.Description>
          Invite DeepSpace users by the email address on their account.
        </Modal.Description>
      </Modal.Header>

      <Modal.Body className="space-y-5">
        <div className="rounded-xl border p-3" style={{ borderColor: 'var(--docs-el-line)' }}>
          <label
            className="mb-2 block text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--docs-el-muted)' }}
          >
            Add people
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Mail
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
                style={{ color: 'var(--docs-el-muted)' }}
              />
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addInvite()
                }}
                placeholder="person@gmail.com"
                className="h-10 w-full rounded-lg border bg-transparent pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                style={{ borderColor: 'var(--docs-el-line)', color: 'var(--docs-el-text)' }}
              />
            </div>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as InviteRole)}
              className="h-10 rounded-lg border bg-transparent px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              style={{ borderColor: 'var(--docs-el-line)', color: 'var(--docs-el-text)' }}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              type="button"
              onClick={() => void addInvite()}
              disabled={saving || !email.trim()}
              className="h-10 rounded-lg px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              style={{ backgroundColor: 'var(--docs-el-accent)' }}
            >
              Add
            </button>
          </div>
        </div>

        <div>
          <div className="mb-3 flex items-center gap-2">
            <Users className="h-4 w-4" style={{ color: 'var(--docs-el-muted)' }} />
            <h3 className="text-sm font-semibold">People with access</h3>
          </div>

          <div className="space-y-2">
            <div
              className="flex items-center gap-3 rounded-xl border p-3"
              style={{ borderColor: 'var(--docs-el-line)' }}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/5 text-xs font-bold dark:bg-white/10">
                {initialsFor(ownerName)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{ownerName}</div>
                <div className="truncate text-xs" style={{ color: 'var(--docs-el-muted)' }}>
                  {ownerRecord?.data.email ?? user?.email ?? 'Owner'}
                </div>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium">
                <ShieldCheck className="h-3.5 w-3.5" />
                Owner
              </span>
            </div>

            {collaboratorRecords.map((u) => {
              const name = u.data.name?.trim() || u.data.email?.trim() || 'Collaborator'
              const userRole: InviteRole = editors.includes(u.recordId) ? 'editor' : 'viewer'
              return (
                <div
                  key={u.recordId}
                  className="flex items-center gap-3 rounded-xl border p-3"
                  style={{ borderColor: 'var(--docs-el-line)' }}
                >
                  {u.data.imageUrl ? (
                    <img
                      src={u.data.imageUrl}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/5 text-xs font-bold dark:bg-white/10">
                      {initialsFor(name)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{name}</div>
                    <div className="truncate text-xs" style={{ color: 'var(--docs-el-muted)' }}>
                      {u.data.email ?? 'No email'}
                    </div>
                  </div>
                  <select
                    value={userRole}
                    onChange={(e) =>
                      void setCollaboratorRole(u.recordId, e.target.value as InviteRole)
                    }
                    disabled={saving}
                    className="h-8 rounded-lg border bg-transparent px-2 text-xs font-medium outline-none"
                    style={{ borderColor: 'var(--docs-el-line)', color: 'var(--docs-el-text)' }}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => void removeCollaborator(u.recordId)}
                    disabled={saving}
                    className="rounded-lg p-1.5 text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                    title="Remove access"
                  >
                    <UserMinus className="h-4 w-4" />
                  </button>
                </div>
              )
            })}

            {collaboratorRecords.length === 0 ? (
              <p
                className="rounded-xl border p-3 text-sm"
                style={{ color: 'var(--docs-el-muted)' }}
              >
                Only the owner can access this document.
              </p>
            ) : null}
          </div>
        </div>
      </Modal.Body>
    </Modal>
  )
}
