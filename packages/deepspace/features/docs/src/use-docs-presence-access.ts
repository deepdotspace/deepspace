import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePresenceRoom, type PresencePeerClient, type UsePresenceRoomResult } from 'deepspace'
import type { Editor } from '@tiptap/react'
import type { DocsPresenceParticipant } from './DocsPresence'
import { parseDocsIdList, type DocsDocumentFields, type InviteAclDiff } from './docs-library-types'

const TYPING_IDLE_MS = 1600
const TYPING_STALE_MS = 5000
/** Re-broadcast presence so clients who connect later still see existing viewers. */
const PRESENCE_HEARTBEAT_MS = 25_000

export type DocsAccessRole = 'owner' | 'editor' | 'viewer' | 'none'
export type AccessChangeKind = 'downgrade' | 'upgrade' | 'revoked'

interface DocsAccessDocument {
  data: Pick<DocsDocumentFields, 'ownerId' | 'collaborators' | 'editors'>
}

interface DocsPresenceUser {
  id: string
  name?: string | null
  email?: string | null
  imageUrl?: string | null
}

interface DetectedAclEvent {
  kind: AccessChangeKind
  at: number
}

export function isDocsOwner(
  document: DocsAccessDocument | null | undefined,
  userId: string | null | undefined,
): boolean {
  return Boolean(document && userId && document.data.ownerId === userId)
}

export function resolveDocsAccessRole(
  document: DocsAccessDocument | null | undefined,
  userId: string | null | undefined,
): DocsAccessRole {
  if (!userId || !document) return 'none'
  if (isDocsOwner(document, userId)) return 'owner'
  if (parseDocsIdList(document.data.editors).includes(userId)) return 'editor'
  if (parseDocsIdList(document.data.collaborators).includes(userId)) return 'viewer'
  return 'none'
}

export function deriveDocsAccessChange(
  initialRole: DocsAccessRole | null,
  effectiveRole: DocsAccessRole,
  detectedEvent: DetectedAclEvent | null,
): AccessChangeKind | null {
  // A presence-derived revoke is the only signal guaranteed to reach a peer
  // whose document subscription was removed, so it takes precedence.
  if (detectedEvent?.kind === 'revoked') return 'revoked'

  if (initialRole && initialRole !== 'owner') {
    if (effectiveRole === 'none') return 'revoked'
    if (initialRole === 'editor' && effectiveRole === 'viewer') return 'downgrade'
    if (initialRole === 'viewer' && effectiveRole === 'editor') return 'upgrade'
  }

  return detectedEvent?.kind ?? null
}

export function detectDocsAclEvent(
  state: Record<string, unknown>,
  userId: string,
  sessionStartedAt: number,
): DetectedAclEvent | null {
  const rawSignal = state.aclSignal
  if (!rawSignal || typeof rawSignal !== 'object') return null

  const signal = rawSignal as {
    at?: unknown
    removed?: unknown
    demoted?: unknown
    promoted?: unknown
  }
  if (typeof signal.at !== 'number' || signal.at <= sessionStartedAt) return null

  const includesUser = (list: unknown): boolean =>
    Array.isArray(list) && list.some((id) => id === userId)

  if (includesUser(signal.removed)) return { kind: 'revoked', at: signal.at }
  if (includesUser(signal.demoted)) return { kind: 'downgrade', at: signal.at }
  if (includesUser(signal.promoted)) return { kind: 'upgrade', at: signal.at }
  return null
}

function peerToDocsParticipant(peer: PresencePeerClient): DocsPresenceParticipant {
  const state = peer.state
  const mode: DocsPresenceParticipant['mode'] = state.mode === 'view' ? 'view' : 'edit'
  const lastTypedAt = typeof state.lastTypedAt === 'number' ? state.lastTypedAt : undefined
  const participant: DocsPresenceParticipant = {
    clientId: 0,
    userId: peer.userId,
    name: peer.userName?.trim() || peer.userEmail?.trim() || 'Guest',
    mode,
    typing: state.typing === true,
    isSelf: false,
  }
  if (peer.userEmail) participant.email = peer.userEmail
  if (peer.userImageUrl) participant.imageUrl = peer.userImageUrl
  if (lastTypedAt != null) participant.lastTypedAt = lastTypedAt
  return participant
}

function sortDocsPresenceParticipants(
  left: DocsPresenceParticipant,
  right: DocsPresenceParticipant,
): number {
  if (left.isSelf !== right.isSelf) return left.isSelf ? -1 : 1
  if (left.mode !== right.mode) return left.mode === 'edit' ? -1 : 1
  return left.name.localeCompare(right.name)
}

function buildDocsPresence(
  peers: PresencePeerClient[],
  self: DocsPresenceUser | null | undefined,
  editMode: boolean,
): DocsPresenceParticipant[] {
  if (!self) {
    return [...peers.map(peerToDocsParticipant)].sort(sortDocsPresenceParticipants)
  }

  const selfRow: DocsPresenceParticipant = {
    clientId: 0,
    userId: self.id,
    name: self.name?.trim() || self.email?.trim() || 'You',
    mode: editMode ? 'edit' : 'view',
    isSelf: true,
  }
  if (self.email) selfRow.email = self.email
  if (self.imageUrl) selfRow.imageUrl = self.imageUrl

  const others = peers.filter((peer) => peer.userId !== self.id).map(peerToDocsParticipant)
  return [selfRow, ...others].sort(sortDocsPresenceParticipants)
}

interface UseDocsPresenceAccessOptions {
  docId: string | undefined
  document: DocsAccessDocument | null | undefined
  user: DocsPresenceUser | null | undefined
  yjsCanWrite: boolean
  writeAuthResolved: boolean
}

interface DocsPresenceAccessResult {
  isOwner: boolean
  effectiveRole: DocsAccessRole
  effectiveCanWrite: boolean
  showReadOnlyDocUx: boolean
  accessChangeKind: AccessChangeKind | null
  handleAclChange: (diff: InviteAclDiff) => void
  presenceAsEditMode: boolean
  presenceRoom: UsePresenceRoomResult
}

export function useDocsPresenceAccess({
  docId,
  document,
  user,
  yjsCanWrite,
  writeAuthResolved,
}: UseDocsPresenceAccessOptions): DocsPresenceAccessResult {
  const presenceRoom = usePresenceRoom(docId ? `doc:${docId}` : '_')
  const { peers, updateState } = presenceRoom
  const isOwner = isDocsOwner(document, user?.id)
  const effectiveRole = resolveDocsAccessRole(document, user?.id)
  const policyCanEdit = effectiveRole === 'owner' || effectiveRole === 'editor'

  /** The first concrete role is the baseline for live ACL transitions. */
  const [initialRole, setInitialRole] = useState<DocsAccessRole | null>(null)
  const sessionStartedAtRef = useRef<number | null>(null)
  useEffect(() => {
    setInitialRole(null)
    sessionStartedAtRef.current = null
  }, [docId])
  useEffect(() => {
    if (initialRole || !document || !user || effectiveRole === 'none') return
    setInitialRole(effectiveRole)
    sessionStartedAtRef.current = Date.now()
  }, [document, effectiveRole, initialRole, user])

  /** Presence reaches peers after document-read access has been revoked. */
  const [detectedAclEvent, setDetectedAclEvent] = useState<DetectedAclEvent | null>(null)
  useEffect(() => {
    setDetectedAclEvent(null)
  }, [docId])
  useEffect(() => {
    if (!user || !document || detectedAclEvent) return
    const sessionStartedAt = sessionStartedAtRef.current
    if (sessionStartedAt == null || user.id === document.data.ownerId) return

    const ownerPeer = peers.find((peer) => peer.userId === document.data.ownerId)
    if (!ownerPeer) return
    const nextEvent = detectDocsAclEvent(ownerPeer.state, user.id, sessionStartedAt)
    if (nextEvent) setDetectedAclEvent(nextEvent)
  }, [detectedAclEvent, document, peers, user])

  const accessChangeKind = useMemo(
    () => deriveDocsAccessChange(initialRole, effectiveRole, detectedAclEvent),
    [detectedAclEvent, effectiveRole, initialRole],
  )
  const accessLocked = accessChangeKind !== null
  const writesLockedByAcl = accessLocked && accessChangeKind !== 'upgrade'
  const effectiveCanWrite = yjsCanWrite && policyCanEdit && !writesLockedByAcl
  const showReadOnlyDocUx =
    effectiveRole === 'viewer' || (policyCanEdit && writeAuthResolved && !yjsCanWrite)
  const presenceAsEditMode =
    policyCanEdit && !(writeAuthResolved && !yjsCanWrite) && !writesLockedByAcl

  const handleAclChange = useCallback(
    (diff: InviteAclDiff) => {
      if (!isOwner) return
      updateState({
        aclSignal: {
          at: Date.now(),
          removed: diff.removedUserIds,
          demoted: diff.demotedUserIds,
          promoted: diff.promotedUserIds,
        },
      })
    },
    [isOwner, updateState],
  )

  return {
    isOwner,
    effectiveRole,
    effectiveCanWrite,
    showReadOnlyDocUx,
    accessChangeKind,
    handleAclChange,
    presenceAsEditMode,
    presenceRoom,
  }
}

interface UseDocsEditorPresenceOptions {
  editor: Editor | null
  document: DocsAccessDocument | null | undefined
  user: DocsPresenceUser | null | undefined
  synced: boolean
  access: DocsPresenceAccessResult
}

export function useDocsEditorPresence({
  editor,
  document,
  user,
  synced,
  access,
}: UseDocsEditorPresenceOptions): {
  participants: DocsPresenceParticipant[]
  typingNames: string[]
} {
  const { effectiveCanWrite, presenceAsEditMode, presenceRoom } = access
  const { peers, connected, updateState } = presenceRoom
  const typingRef = useRef(false)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const participants = useMemo(
    () => buildDocsPresence(peers, user, presenceAsEditMode),
    [peers, presenceAsEditMode, user],
  )

  const publishPresence = useCallback(
    (typing: boolean) => {
      if (!document || !user || !synced) return
      updateState({
        mode: presenceAsEditMode ? 'edit' : 'view',
        typing,
        ...(typing ? { lastTypedAt: Date.now() } : {}),
      })
    },
    [document, presenceAsEditMode, synced, updateState, user],
  )

  useEffect(() => {
    if (!editor) return
    const onUpdate = () => {
      if (!effectiveCanWrite) return
      typingRef.current = true
      publishPresence(true)
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = setTimeout(() => {
        typingRef.current = false
        publishPresence(false)
      }, TYPING_IDLE_MS)
    }
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
    }
  }, [editor, effectiveCanWrite, publishPresence])

  useEffect(() => {
    publishPresence(typingRef.current)
  }, [connected, publishPresence])

  useEffect(() => {
    if (!synced || !document || !user) return
    const id = window.setInterval(() => publishPresence(typingRef.current), PRESENCE_HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [document, publishPresence, synced, user])

  const typingNames = useMemo(() => {
    const names: string[] = []
    const seen = new Set<string>()
    for (const participant of participants) {
      if (participant.isSelf || !participant.typing) continue
      if (
        participant.lastTypedAt != null &&
        Date.now() - participant.lastTypedAt >= TYPING_STALE_MS
      ) {
        continue
      }
      if (seen.has(participant.name)) continue
      seen.add(participant.name)
      names.push(participant.name)
    }
    return names
  }, [participants])

  return { participants, typingNames }
}
