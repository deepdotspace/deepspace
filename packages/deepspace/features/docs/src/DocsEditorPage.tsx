/**
 * DocsEditorPage — Tiptap + Yjs collaborative document editor.
 *
 * Replaces the previous contenteditable + HTML-in-Y.Text approach with
 * ProseMirror-via-Tiptap bound to a Y.XmlFragment. Remote keystrokes are
 * applied as granular PM transactions (no `innerHTML` swap), the local
 * caret is migrated through concurrent edits by PM's position mapping,
 * and remote cursors are painted by `@tiptap/extension-collaboration-caret`.
 *
 * Legacy docs created with the old editor stored HTML in Y.Text('content').
 * On first open by an editor/owner we migrate that into the new XmlFragment
 * via `editor.commands.setContent(html)` and clear the legacy field. The
 * migration is a single Yjs transaction so all peers converge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useRouteError, isRouteErrorResponse } from 'react-router-dom'
import {
  useUser,
  useQuery,
  useMutations,
  usePresenceRoom,
  getUserColor,
  type PresencePeerClient,
} from 'deepspace'
import { ArrowLeft, AlertTriangle, List as ListIcon, RefreshCw, Share2 } from 'lucide-react'
import { Badge } from '@/components/ui'
import { type Editor, useEditorState } from '@tiptap/react'
import { useYjsRoomWithAwareness } from './use-yjs-room-with-awareness'
import { useDocEditor } from './editor/useDocEditor'
import { DocEditorSurface, PAGE_HEIGHT_PX, PAGE_WIDTH_PX } from './editor/DocEditorSurface'
import { DocsTiptapToolbar } from './editor/DocsTiptapToolbar'
import { DocsOutlinePanel, DOCUMENT_OUTLINE_WIDTH_PX, type OutlineEntry } from './DocsOutlinePanel'
import { DocsPresence, type DocsPresenceParticipant } from './DocsPresence'
import { InviteDialog, type InviteAclDiff } from './InviteDialog'
import './docs-ui.css'

interface DocumentFields {
  title: string
  ownerId: string
  collaborators?: string
  editors?: string
  folderId?: string
}

const CANVAS_ZOOM_KEY = 'deepspace-docs-editor-canvas-zoom'
const OUTLINE_OPEN_KEY = 'deepspace-docs-editor-outline-open'
const KEYBOARD_ZOOM_STEP = 0.1
const TYPING_IDLE_MS = 1600
const TYPING_STALE_MS = 5000
/** Re-broadcast presence so clients who connect later still see existing viewers. */
const PRESENCE_HEARTBEAT_MS = 25_000
const DOC_NOT_FOUND_GRACE_MS = 450

function normalizeZoom(z: number): number {
  return Math.min(2, Math.max(0.5, Math.round(z * 1000) / 1000))
}

function parseIdList(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function peerToDocsParticipant(p: PresencePeerClient): DocsPresenceParticipant {
  const state = p.state
  const mode: DocsPresenceParticipant['mode'] = state.mode === 'view' ? 'view' : 'edit'
  const lastTypedAt = typeof state.lastTypedAt === 'number' ? state.lastTypedAt : undefined
  const participant: DocsPresenceParticipant = {
    clientId: 0,
    userId: p.userId,
    name: p.userName?.trim() || p.userEmail?.trim() || 'Guest',
    mode,
    typing: state.typing === true,
    isSelf: false,
  }
  if (p.userEmail) participant.email = p.userEmail
  if (p.userImageUrl) participant.imageUrl = p.userImageUrl
  if (lastTypedAt != null) participant.lastTypedAt = lastTypedAt
  return participant
}

function sortDocsPresenceParticipants(
  a: DocsPresenceParticipant,
  b: DocsPresenceParticipant,
): number {
  if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1
  if (a.mode !== b.mode) return a.mode === 'edit' ? -1 : 1
  return a.name.localeCompare(b.name)
}

interface DocsPresenceSelfUser {
  id: string
  name?: string | null
  email?: string | null
  imageUrl?: string | null
}

function buildDocsPresence(
  peers: PresencePeerClient[],
  self: DocsPresenceSelfUser | null | undefined,
  presenceAsEditMode: boolean,
): DocsPresenceParticipant[] {
  if (!self) {
    return [...peers.map(peerToDocsParticipant)].sort(sortDocsPresenceParticipants)
  }

  const selfRow: DocsPresenceParticipant = {
    clientId: 0,
    userId: self.id,
    name: self.name?.trim() || self.email?.trim() || 'You',
    mode: presenceAsEditMode ? 'edit' : 'view',
    isSelf: true,
  }
  if (self.email) selfRow.email = self.email
  if (self.imageUrl) selfRow.imageUrl = self.imageUrl

  const others = peers.filter((p) => p.userId !== self.id).map(peerToDocsParticipant)
  return [selfRow, ...others].sort(sortDocsPresenceParticipants)
}

function InlineTitle({
  title,
  canEdit,
  onSave,
}: {
  title: string
  canEdit: boolean
  onSave: (next: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setValue(title)
  }, [title])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commit = () => {
    const t = value.trim()
    if (t && t !== title) onSave(t)
    else setValue(title)
    setEditing(false)
  }

  if (!canEdit || !editing) {
    return (
      <h1
        className="min-w-0 flex-1 cursor-text truncate rounded px-1 text-lg font-semibold tracking-tight transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        style={{ color: 'var(--docs-el-text)' }}
        onClick={() => canEdit && setEditing(true)}
        title={canEdit ? 'Click to rename' : undefined}
      >
        {title}
      </h1>
    )
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          setValue(title)
          setEditing(false)
        }
      }}
      className="min-w-0 flex-1 rounded border px-2 py-0.5 text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
      style={{
        borderColor: 'var(--docs-el-line)',
        backgroundColor: 'var(--docs-el-bg)',
        color: 'var(--docs-el-text)',
      }}
    />
  )
}

type AccessChangeKind = 'downgrade' | 'upgrade' | 'revoked'

/**
 * Full-screen overlay shown to the second user when the owner changes their
 * permissions mid-session. Three cases:
 *
 *   - `downgrade`: editor → viewer. We block the editor surface so an
 *     in-flight keystroke can't slip past the role boundary while Yjs and the
 *     `documents` record settle on the new permission, and prompt the user to
 *     refresh the route. Without this, the Tiptap editor view is rebuilt with
 *     a new placeholder/extensions array (because `showReadOnlyDocUx` flips)
 *     which races a stale `requestAnimationFrame` in `DocEditorSurface` and
 *     throws `Cannot read properties of null (reading 'matchesNode')`.
 *
 *   - `upgrade`: viewer → editor. Same editor-rebuild path on the local peer
 *     (the placeholder string flips the other way), so a refresh gives the
 *     user a clean Tiptap mount with editing enabled and no risk of the
 *     stale-rAF crash in the rebuild.
 *
 *   - `revoked`: the owner removed this peer from `collaborators`/`editors`
 *     entirely. The Yjs server-side auth cache plus the locally-cached
 *     `documents` row let the peer keep typing for a few seconds until they
 *     reconnect; the overlay locks the UI immediately so no further edits are
 *     attempted, and tells the user to refresh to leave.
 */
function AccessChangedOverlay({
  kind,
  onRefresh,
}: {
  kind: AccessChangeKind
  onRefresh: () => void
}) {
  const title =
    kind === 'revoked'
      ? 'Your access has been removed'
      : kind === 'upgrade'
        ? 'You can now edit this document'
        : "You're now view-only"
  const body =
    kind === 'revoked'
      ? 'The owner has removed your access to this document. Refresh to continue.'
      : kind === 'upgrade'
        ? 'The owner gave you editor access. Refresh to reload the document with editing enabled.'
        : 'The owner changed your access to view-only. Refresh to reload the document.'

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="docs-access-change-title"
      className="absolute inset-0 z-[80] flex items-center justify-center px-4"
      style={{ backgroundColor: 'color-mix(in srgb, var(--docs-el-bg) 78%, transparent)' }}
    >
      <div
        className="w-full max-w-sm rounded-xl border p-6 shadow-xl backdrop-blur"
        style={{
          borderColor: 'var(--docs-el-line)',
          backgroundColor: 'var(--docs-el-surface)',
          color: 'var(--docs-el-text)',
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--docs-el-accent) 14%, transparent)',
              color: 'var(--docs-el-accent)',
            }}
            aria-hidden
          >
            <AlertTriangle className="h-4 w-4" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="docs-access-change-title" className="text-base font-semibold tracking-tight">
              {title}
            </h2>
            <p className="mt-1.5 text-sm" style={{ color: 'var(--docs-el-muted)' }}>
              {body}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onRefresh}
            data-testid="docs-access-refresh"
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--docs-el-accent)' }}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2.25} />
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Rendered while we don't yet have a Tiptap editor to mount (initial mount,
 * docId switch, or while Yjs is still syncing). Crucially this mirrors the
 * exact geometry of {@link DocEditorSurface} — same canvas, same paged
 * page-frame, same blank paper — so when the real surface takes over the
 * swap is invisible. No `animate-pulse` skeleton bars: those used to flash
 * for a single frame on fast loads, which read as a "flicker".
 */
function DocsEditorLoadingSurface({ label = 'Opening document...' }: { label?: string }) {
  return (
    <div className="docs-paged-editor-canvas h-full min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain print:block print:!h-auto print:!overflow-visible print:!bg-white">
      <div className="docs-paged-inner pointer-events-auto mx-auto w-full max-w-full px-2 py-3 sm:px-3 sm:py-4 md:py-5">
        <div
          className="docs-paged-page-frame relative mx-auto"
          style={{ width: `${PAGE_WIDTH_PX / 96}in`, maxWidth: '100%' }}
          aria-busy="true"
          aria-label={label}
        >
          <div
            className="docs-paged-page-stack relative"
            style={{ minHeight: `${PAGE_HEIGHT_PX}px` }}
          >
            <div className="docs-paged-page-face docs-editor-paper pointer-events-none absolute left-0 top-0 h-[11in] w-full rounded-sm print:static print:h-auto print:shadow-none print:border-0" />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Walk the ProseMirror doc once per editor update, returning headings.
 * Cheap (linear in node count) and keeps the outline panel in lockstep
 * with what's actually rendered.
 */
function useOutlineEntries(editor: Editor | null): OutlineEntry[] {
  return (
    useEditorState({
      editor,
      selector: ({ editor: e }) => {
        // Same defensive checks as the toolbar selector — `e.state` is null
        // when the underlying ProseMirror view has been torn down.
        if (!e || e.isDestroyed || !e.view) return [] as OutlineEntry[]
        try {
          const out: OutlineEntry[] = []
          e.state.doc.descendants((node, pos) => {
            if (node.type.name === 'heading') {
              const level = (node.attrs.level as number) ?? 1
              const title = node.textContent.trim()
              if (title) out.push({ level, title, pos })
              return false
            }
            return true
          })
          return out
        } catch {
          return [] as OutlineEntry[]
        }
      },
    }) ?? []
  )
}

export default function DocsEditorPage() {
  const { docId } = useParams<{ docId: string }>()
  const navigate = useNavigate()
  const { user } = useUser()

  const { records: documents, status } = useQuery<DocumentFields>('documents', {
    orderBy: 'createdAt',
    orderDir: 'desc',
  })

  const selectedDoc = useMemo(
    () => (docId ? documents.find((d) => d.recordId === docId) : null),
    [documents, docId],
  )

  const { put } = useMutations<DocumentFields>('documents')

  /**
   * `'content'` is kept as the field name only so legacy-doc migration can
   * read the old HTML out of Y.Text('content') below. The Tiptap editor
   * itself binds to a separate Y.XmlFragment('default') inside the same
   * Y.Doc — they don't collide.
   */
  const {
    doc,
    text: legacyText,
    synced,
    canWrite,
    writeAuthResolved,
    awareness,
  } = useYjsRoomWithAwareness(docId ?? 'noop', 'content')

  const presenceScopeId = docId ? `doc:${docId}` : '_'
  const {
    peers: presencePeers,
    connected: presenceConnected,
    updateState: updatePresenceState,
  } = usePresenceRoom(presenceScopeId)

  const [inviteOpen, setInviteOpen] = useState(false)
  const typingRef = useRef(false)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [canvasZoom, setCanvasZoom] = useState(() => {
    if (typeof window === 'undefined') return 1
    try {
      const raw = sessionStorage.getItem(CANVAS_ZOOM_KEY)
      const v = raw == null ? 1 : Number.parseFloat(raw)
      return normalizeZoom(Number.isFinite(v) ? v : 1)
    } catch {
      return 1
    }
  })

  const [outlineOpen, setOutlineOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    try {
      return window.localStorage.getItem(OUTLINE_OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })

  useEffect(() => {
    try {
      sessionStorage.setItem(CANVAS_ZOOM_KEY, String(canvasZoom))
    } catch {
      /* ignore */
    }
  }, [canvasZoom])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key
      const isZoomIn = key === '+' || key === '='
      const isZoomOut = key === '-' || key === '_'
      const isReset = key === '0'
      if (!isZoomIn && !isZoomOut && !isReset) return

      event.preventDefault()
      event.stopPropagation()
      setCanvasZoom((current) => {
        if (isReset) return 1
        return normalizeZoom(current + (isZoomIn ? KEYBOARD_ZOOM_STEP : -KEYBOARD_ZOOM_STEP))
      })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(OUTLINE_OPEN_KEY, outlineOpen ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [outlineOpen])

  // Permissions ----------------------------------------------------------------
  const isOwner = selectedDoc?.data.ownerId === user?.id
  const collaboratorIds = useMemo(
    () => parseIdList(selectedDoc?.data.collaborators),
    [selectedDoc?.data.collaborators],
  )
  const editorIds = useMemo(
    () => parseIdList(selectedDoc?.data.editors),
    [selectedDoc?.data.editors],
  )
  const effectiveRole: 'owner' | 'editor' | 'viewer' | 'none' = !user
    ? 'none'
    : isOwner
      ? 'owner'
      : editorIds.includes(user.id)
        ? 'editor'
        : collaboratorIds.includes(user.id)
          ? 'viewer'
          : 'none'
  const policyCanEdit = effectiveRole === 'owner' || effectiveRole === 'editor'

  /**
   * Snapshot of the *first* concrete role this peer saw for this `docId`,
   * plus the wall-clock instant when we captured it. We can't trust
   * `effectiveRole` alone to detect "the owner just removed me" because
   * role transitions (none → editor on initial fetch, editor → viewer on
   * demote, viewer → none on remove) all flow through the same `none`
   * value before/after `selectedDoc` resolves. The role tells us
   * downgrade/upgrade vs. still-loading; the timestamp lets us ignore
   * stale `aclSignal` presence updates from before we joined.
   */
  const [initialRole, setInitialRole] = useState<typeof effectiveRole | null>(null)
  const sessionStartedAtRef = useRef<number | null>(null)
  useEffect(() => {
    setInitialRole(null)
    sessionStartedAtRef.current = null
  }, [docId])
  useEffect(() => {
    if (initialRole) return
    if (!selectedDoc || !user) return
    if (effectiveRole === 'none') return
    setInitialRole(effectiveRole)
    sessionStartedAtRef.current = Date.now()
  }, [initialRole, selectedDoc, user, effectiveRole])

  /**
   * Latched permission-change event delivered over presence. The owner
   * publishes an `aclSignal` payload after every InviteDialog save; peers
   * watch the owner's presence state and freeze the first signal addressed
   * to them. This is the only mechanism that reaches a *removed* user,
   * since the docs schema's `read: 'collaborator'` rule means the
   * documents-record update with the new collaborators list is filtered
   * out of their RecordRoom subscription — the kicked client would
   * otherwise keep its stale role indefinitely and let the user keep
   * typing until they refresh.
   */
  type DetectedAclEvent = { kind: AccessChangeKind; at: number }
  const [detectedAclEvent, setDetectedAclEvent] = useState<DetectedAclEvent | null>(null)
  useEffect(() => {
    setDetectedAclEvent(null)
  }, [docId])

  const accessChangeKind: AccessChangeKind | null = useMemo(() => {
    // Latched presence-derived revoke always wins — it's the only signal
    // that reaches a peer whose record subscription was filtered out.
    if (detectedAclEvent?.kind === 'revoked') return 'revoked'

    // Local-record-derived transitions cover the cases where the
    // documents record still propagates (downgrade / upgrade). They
    // need an initial concrete role to compare against; without one
    // we fall through to whatever presence latched.
    if (initialRole && initialRole !== 'owner') {
      if (effectiveRole === 'none') return 'revoked'
      if (initialRole === 'editor' && effectiveRole === 'viewer') return 'downgrade'
      if (initialRole === 'viewer' && effectiveRole === 'editor') return 'upgrade'
    }

    return detectedAclEvent?.kind ?? null
  }, [initialRole, effectiveRole, detectedAclEvent])
  const accessLocked = accessChangeKind !== null

  /**
   * Once the owner revokes/downgrades, we hard-stop further writes from this
   * peer even if Yjs/server auth hasn't caught up yet. Combined with the
   * blocking overlay below, this prevents the "removed user can still type
   * until refresh" window described in the report.
   */
  const writesLockedByAcl = accessLocked && accessChangeKind !== 'upgrade'
  const effectiveCanWrite = canWrite && policyCanEdit && !writesLockedByAcl
  /** Collaborator viewers always see read-only chrome; editors/owners only after Yjs auth resolves and denies write. */
  const showReadOnlyDocUx =
    effectiveRole === 'viewer' || (policyCanEdit && writeAuthResolved && !canWrite)
  const presenceAsEditMode =
    policyCanEdit && !(writeAuthResolved && !canWrite) && !writesLockedByAcl

  // Tiptap editor --------------------------------------------------------------
  const userName = user?.name?.trim() || user?.email?.trim() || 'Guest'
  const userColor = useMemo(() => getUserColor(user?.id ?? 'anon'), [user?.id])
  const editor = useDocEditor({
    doc,
    awareness,
    userName,
    userColor,
    synced,
    canWrite: effectiveCanWrite,
    placeholder: showReadOnlyDocUx ? 'View only' : 'Start typing — toolbar above for formatting…',
  })

  // Legacy migration: if doc.getXmlFragment('default') is empty but the
  // legacy Y.Text('content') field has HTML, parse it once into Tiptap.
  // Only the first writer to open does this; viewers never see partial state
  // because both the wipe and the parse run inside a single Yjs transaction.
  const migratedRef = useRef(false)
  useEffect(() => {
    if (migratedRef.current) return
    if (!editor || !synced || !effectiveCanWrite) return
    const fragment = doc.getXmlFragment('default')
    if (fragment.length > 0) {
      migratedRef.current = true
      return
    }
    const yText = doc.getText('content')
    const legacy = (legacyText ?? yText.toString()).trim()
    if (!legacy) {
      migratedRef.current = true
      return
    }
    migratedRef.current = true
    /**
     * Tiptap parses the HTML against its schema, then writes the resulting
     * nodes into the bound Y.XmlFragment. We then clear the legacy field
     * inside the same transaction so peers see one atomic step.
     */
    doc.transact(() => {
      editor.commands.setContent(legacy, { emitUpdate: true })
      if (yText.length > 0) yText.delete(0, yText.length)
    })
  }, [editor, synced, effectiveCanWrite, doc, legacyText])

  // Presence -------------------------------------------------------------------
  const presenceParticipants = useMemo(
    () => buildDocsPresence(presencePeers, user ?? undefined, presenceAsEditMode),
    [presencePeers, user, presenceAsEditMode],
  )

  const publishPresence = useCallback(
    (typingFlag: boolean) => {
      if (!selectedDoc || !user || !synced) return
      updatePresenceState({
        mode: presenceAsEditMode ? 'edit' : 'view',
        typing: typingFlag,
        ...(typingFlag ? { lastTypedAt: Date.now() } : {}),
      })
    },
    [presenceAsEditMode, selectedDoc, synced, updatePresenceState, user],
  )

  /**
   * Permission-change fan-out via presence.
   *
   * The owner publishes a one-shot `aclSignal` payload after every
   * InviteDialog save. The PresenceRoom server merges incoming state into
   * each peer's record, so this field rides alongside the existing
   * `mode`/`typing`/`lastTypedAt` fields without clobbering them. We
   * intentionally route through presence rather than the documents record
   * because the docs schema's `read: 'collaborator'` rule prevents a
   * just-removed user from seeing the new record state — presence is the
   * only channel still wired to them at the moment of revocation.
   */
  const handleAclChange = useCallback(
    (diff: InviteAclDiff) => {
      if (!isOwner) return
      updatePresenceState({
        aclSignal: {
          at: Date.now(),
          removed: diff.removedUserIds,
          demoted: diff.demotedUserIds,
          promoted: diff.promotedUserIds,
        },
      })
    },
    [isOwner, updatePresenceState],
  )

  /**
   * Latch the first relevant `aclSignal` we see from the owner's presence
   * peer. We compare its `at` against `sessionStartedAtRef` so refreshing
   * into a doc whose owner already published a signal doesn't immediately
   * trip the overlay — only signals emitted *after* this session began
   * count. Once latched we keep the value: even if the owner disconnects
   * and their presence peer vanishes, the overlay must persist.
   */
  useEffect(() => {
    if (!user || !selectedDoc) return
    if (detectedAclEvent) return
    const start = sessionStartedAtRef.current
    if (start == null) return
    const ownerId = selectedDoc.data.ownerId
    if (user.id === ownerId) return
    const ownerPeer = presencePeers.find((p) => p.userId === ownerId)
    if (!ownerPeer) return

    const rawSignal = (ownerPeer.state as Record<string, unknown>).aclSignal
    if (!rawSignal || typeof rawSignal !== 'object') return
    const signal = rawSignal as {
      at?: unknown
      removed?: unknown
      demoted?: unknown
      promoted?: unknown
    }
    if (typeof signal.at !== 'number' || signal.at <= start) return

    const includes = (list: unknown): boolean =>
      Array.isArray(list) && list.some((id) => id === user.id)

    if (includes(signal.removed)) {
      setDetectedAclEvent({ kind: 'revoked', at: signal.at })
    } else if (includes(signal.demoted)) {
      setDetectedAclEvent({ kind: 'downgrade', at: signal.at })
    } else if (includes(signal.promoted)) {
      setDetectedAclEvent({ kind: 'upgrade', at: signal.at })
    }
  }, [presencePeers, user, selectedDoc, detectedAclEvent])

  // Typing flag — driven by Tiptap's `update` event (debounced idle reset).
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

  // Initial presence + heartbeat so late joiners still see existing viewers.
  useEffect(() => {
    publishPresence(typingRef.current)
  }, [publishPresence, presenceConnected])

  useEffect(() => {
    if (!synced || !selectedDoc || !user) return
    const id = window.setInterval(() => publishPresence(typingRef.current), PRESENCE_HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [synced, selectedDoc, user, publishPresence])

  // Typing names from presence (stale-aware).
  const typingNames = useMemo(() => {
    const names: string[] = []
    const seen = new Set<string>()
    for (const p of presenceParticipants) {
      if (p.isSelf || !p.typing) continue
      if (p.lastTypedAt != null && Date.now() - p.lastTypedAt >= TYPING_STALE_MS) continue
      if (seen.has(p.name)) continue
      seen.add(p.name)
      names.push(p.name)
    }
    return names
  }, [presenceParticipants])

  // Outline --------------------------------------------------------------------
  const outlineEntries = useOutlineEntries(editor)
  const jumpToHeading = useCallback(
    (pos: number) => {
      if (!editor) return
      editor.chain().focus().setTextSelection(pos).scrollIntoView().run()
    },
    [editor],
  )

  // Title save -----------------------------------------------------------------
  const docTitle = selectedDoc?.data.title?.trim() || 'Untitled Document'
  const handleTitleSave = useCallback(
    async (next: string) => {
      if (!selectedDoc) return
      await put(selectedDoc.recordId, { ...selectedDoc.data, title: next }).catch(() => {})
    },
    [put, selectedDoc],
  )

  /**
   * Loading / not-found are intentionally NOT alternative early-return
   * layouts — swapping the whole page between a skeleton chrome and the real
   * chrome produced a visible flash on create/open. We render one full layout
   * and swap only the editor area for not-found vs paper vs live ProseMirror.
   * The Tiptap instance mounts as soon as it is ready (before Yjs `synced`);
   * the header, toolbar shell, and paper stay stable while the connection
   * finishes and document content hydrates from the room.
   */
  const isLoading = status === 'loading'
  const [showNotFound, setShowNotFound] = useState(false)

  useEffect(() => {
    if (isLoading || selectedDoc) {
      setShowNotFound(false)
      return
    }

    const id = window.setTimeout(() => setShowNotFound(true), DOC_NOT_FOUND_GRACE_MS)
    return () => window.clearTimeout(id)
  }, [docId, isLoading, selectedDoc])

  const docResolutionPending = isLoading || (!selectedDoc && !showNotFound)
  const docMissing = !isLoading && !selectedDoc && showNotFound

  return (
    <div
      className="docs-feature-scope flex h-full flex-col overflow-hidden print:h-auto print:overflow-visible"
      style={{ backgroundColor: 'var(--docs-el-bg)', color: 'var(--docs-el-text)' }}
    >
      <header
        className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-3 backdrop-blur-sm print:hidden sm:gap-3 sm:px-4"
        style={{
          borderColor: 'var(--docs-el-line)',
          backgroundColor: 'color-mix(in srgb, var(--docs-el-surface) 92%, transparent)',
        }}
      >
        <button
          type="button"
          onClick={() => navigate('/docs')}
          className="rounded-lg p-1.5 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          style={{ color: 'var(--docs-el-muted)' }}
          title="Back to documents"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2} />
        </button>

        <InlineTitle title={docTitle} canEdit={isOwner ?? false} onSave={handleTitleSave} />

        <DocsPresence participants={presenceParticipants} typingNames={typingNames} />

        <div className="flex shrink-0 items-center gap-3">
          {isOwner ? (
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              style={{
                borderColor: 'var(--docs-el-line)',
                color: 'var(--docs-el-muted)',
                backgroundColor: 'transparent',
              }}
              title="Share this document"
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </button>
          ) : effectiveRole === 'editor' || effectiveRole === 'viewer' ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
              style={{ borderColor: 'var(--docs-el-line)', color: 'var(--docs-el-muted)' }}
            >
              {effectiveRole === 'editor' ? 'Shared editor' : 'Shared viewer'}
            </span>
          ) : null}
          {synced ? (
            <span
              className="flex items-center gap-1.5 text-xs tabular-nums"
              style={{ color: 'var(--docs-el-muted)' }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
              Synced
            </span>
          ) : (
            <span
              className="flex items-center gap-1.5 text-xs tabular-nums"
              style={{ color: 'var(--docs-el-muted)' }}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden />
              Connecting…
            </span>
          )}
          {effectiveRole === 'owner' ? (
            <Badge variant="success">Owner</Badge>
          ) : effectiveRole === 'editor' ? (
            <Badge variant="success">Editor</Badge>
          ) : effectiveRole === 'viewer' ? (
            <Badge variant="secondary">Viewer</Badge>
          ) : effectiveCanWrite ? (
            <Badge variant="success">Edit</Badge>
          ) : (
            <Badge variant="secondary">View</Badge>
          )}
        </div>
      </header>

      {showReadOnlyDocUx ? (
        <div
          className="relative z-10 flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm print:hidden"
          style={{
            borderColor: 'var(--docs-el-line)',
            backgroundColor: 'color-mix(in srgb, var(--docs-el-muted) 12%, transparent)',
            color: 'var(--docs-el-muted)',
          }}
        >
          {effectiveRole === 'viewer'
            ? 'You have view-only access to this document. Ask the owner for editor access.'
            : 'You are viewing this document in read-only mode.'}
        </div>
      ) : null}

      <DocsTiptapToolbar
        editor={editor}
        disabled={!synced || !effectiveCanWrite}
        canvasZoom={canvasZoom}
        onCanvasZoomChange={(z) => setCanvasZoom(normalizeZoom(z))}
      />

      <div className="relative flex min-h-0 flex-1 flex-col print:block">
        {outlineOpen ? (
          <DocsOutlinePanel entries={outlineEntries} onJumpTo={jumpToHeading} />
        ) : null}

        <button
          type="button"
          data-testid="toggle-outline"
          onClick={() => setOutlineOpen((o) => !o)}
          title={outlineOpen ? 'Hide document outline' : 'Show document outline'}
          style={{
            top: 12,
            left: outlineOpen ? DOCUMENT_OUTLINE_WIDTH_PX + 10 : 12,
            borderColor: 'color-mix(in srgb, var(--docs-el-line) 85%, transparent)',
            backgroundColor: 'color-mix(in srgb, var(--docs-el-surface) 92%, transparent)',
            color: 'var(--docs-el-muted)',
          }}
          className={`absolute z-[36] flex h-9 w-9 items-center justify-center rounded-full border shadow-md backdrop-blur-md transition-[left,box-shadow,color] duration-200 ease-out hover:bg-black/[0.06] hover:text-[color:var(--docs-el-text)] hover:shadow-lg print:hidden dark:border-white/12 dark:hover:bg-white/[0.08] ${outlineOpen ? 'text-[color:var(--docs-el-text)]' : ''}`}
        >
          <ListIcon className="h-4 w-4" strokeWidth={2} />
        </button>

        <div
          data-testid="doc-canvas-zoom"
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden print:[zoom:1]"
          style={{
            zoom: canvasZoom,
            paddingLeft: outlineOpen ? DOCUMENT_OUTLINE_WIDTH_PX : 0,
          }}
        >
          {docMissing ? (
            <div className="docs-paged-editor-canvas flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 px-6">
              <p className="text-sm" style={{ color: 'var(--docs-el-muted)' }}>
                This document is private. Ask the owner for an invite.
              </p>
              <button
                type="button"
                onClick={() => navigate('/docs')}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: 'var(--docs-el-accent)' }}
              >
                Back to documents
              </button>
            </div>
          ) : editor && !docResolutionPending ? (
            <DocEditorSurface editor={editor} />
          ) : (
            <DocsEditorLoadingSurface
              label={isLoading ? 'Opening document...' : 'Resolving document...'}
            />
          )}
          {accessChangeKind ? (
            <AccessChangedOverlay
              kind={accessChangeKind}
              onRefresh={() => window.location.reload()}
            />
          ) : null}
        </div>
      </div>

      {selectedDoc ? (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          doc={selectedDoc}
          isOwner={isOwner ?? false}
          onAclChange={handleAclChange}
        />
      ) : null}
    </div>
  )
}

/**
 * Route-level error boundary. Generouted picks up the `ErrorBoundary` export
 * and wires it to the route's `errorElement` prop, so any render-time throw
 * inside this route (notably the ProseMirror `matchesNode` crash when the
 * owner toggles a peer's role mid-session) is contained here instead of
 * blowing up the whole app with the React Router default screen.
 *
 * The recovery path is a hard reload — Yjs/Tiptap state at the moment of
 * the crash is no longer trustworthy, and the new permissions on the doc
 * are already authoritative on the server.
 */
export function ErrorBoundary() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Something went wrong while loading this document.'

  return (
    <div
      data-testid="docs-route-error"
      className="docs-feature-scope flex h-full flex-col items-center justify-center px-6 text-center"
      style={{ backgroundColor: 'var(--docs-el-bg)', color: 'var(--docs-el-text)' }}
    >
      <div
        className="w-full max-w-md rounded-xl border p-6 shadow-md"
        style={{ borderColor: 'var(--docs-el-line)', backgroundColor: 'var(--docs-el-surface)' }}
      >
        <div className="mb-3 flex items-center justify-center">
          <span
            className="inline-flex h-10 w-10 items-center justify-center rounded-full"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--docs-el-accent) 14%, transparent)',
              color: 'var(--docs-el-accent)',
            }}
            aria-hidden
          >
            <AlertTriangle className="h-5 w-5" strokeWidth={2} />
          </span>
        </div>
        <h1 className="text-base font-semibold tracking-tight">This document needs to reload</h1>
        <p className="mx-auto mt-1.5 max-w-xs text-sm" style={{ color: 'var(--docs-el-muted)' }}>
          Your access to this document just changed. Refresh to load the latest version.
        </p>
        <p
          className="mx-auto mt-3 max-w-xs truncate text-xs"
          style={{ color: 'var(--docs-el-muted)' }}
          title={message}
        >
          {message}
        </p>
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            autoFocus
            onClick={() => window.location.reload()}
            data-testid="docs-route-error-refresh"
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--docs-el-accent)' }}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2.25} />
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
}
