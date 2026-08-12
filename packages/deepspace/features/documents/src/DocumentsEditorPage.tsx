/**
 * DocumentsEditorPage — Tiptap + Yjs collaborative document editor.
 *
 * Replaces the previous contenteditable + HTML-in-Y.Text approach with
 * ProseMirror-via-Tiptap bound to a Y.XmlFragment. Remote keystrokes are
 * applied as granular PM transactions (no `innerHTML` swap), the local
 * caret is migrated through concurrent edits by PM's position mapping,
 * and remote cursors are painted by `@tiptap/extension-collaboration-caret`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useRouteError, isRouteErrorResponse } from 'react-router-dom'
import { getUserColor, useMutations, useQuery, useUser, useYjsRoom } from 'deepspace'
import { ArrowLeft, AlertTriangle, List as ListIcon, RefreshCw, Share2 } from 'lucide-react'
import { Badge } from '@/components/ui'
import { type Editor, useEditorState } from '@tiptap/react'
import { useDocEditor } from './editor/useDocEditor'
import { DocEditorSurface, PAGE_HEIGHT_PX, PAGE_WIDTH_PX } from './editor/DocEditorSurface'
import { DocumentsTiptapToolbar } from './editor/DocumentsTiptapToolbar'
import {
  DocumentsOutlinePanel,
  DOCUMENT_OUTLINE_WIDTH_PX,
  type OutlineEntry,
} from './DocumentsOutlinePanel'
import { DocumentsPresence } from './DocumentsPresence'
import { InviteDialog } from './InviteDialog'
import { recordsReadyForMutation, type DocumentsDocumentFields } from './documents-library-types'
import {
  useDocumentsEditorPresence,
  useDocumentsPresenceAccess,
  type AccessChangeKind,
} from './use-documents-presence-access'
import './documents-ui.css'

const CANVAS_ZOOM_KEY = 'deepspace-documents-editor-canvas-zoom'
const OUTLINE_OPEN_KEY = 'deepspace-documents-editor-outline-open'
const KEYBOARD_ZOOM_STEP = 0.1
const DOC_NOT_FOUND_GRACE_MS = 450

function normalizeZoom(z: number): number {
  return Math.min(2, Math.max(0.5, Math.round(z * 1000) / 1000))
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
        style={{ color: 'var(--documents-el-text)' }}
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
        borderColor: 'var(--documents-el-line)',
        backgroundColor: 'var(--documents-el-bg)',
        color: 'var(--documents-el-text)',
      }}
    />
  )
}

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
      aria-labelledby="documents-access-change-title"
      className="absolute inset-0 z-[80] flex items-center justify-center px-4"
      style={{ backgroundColor: 'color-mix(in srgb, var(--documents-el-bg) 78%, transparent)' }}
    >
      <div
        className="w-full max-w-sm rounded-xl border p-6 shadow-xl backdrop-blur"
        style={{
          borderColor: 'var(--documents-el-line)',
          backgroundColor: 'var(--documents-el-surface)',
          color: 'var(--documents-el-text)',
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--documents-el-accent) 14%, transparent)',
              color: 'var(--documents-el-accent)',
            }}
            aria-hidden
          >
            <AlertTriangle className="h-4 w-4" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="documents-access-change-title"
              className="text-base font-semibold tracking-tight"
            >
              {title}
            </h2>
            <p className="mt-1.5 text-sm" style={{ color: 'var(--documents-el-muted)' }}>
              {body}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onRefresh}
            data-testid="documents-access-refresh"
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--documents-el-accent)' }}
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
function DocumentsEditorLoadingSurface({ label = 'Opening document...' }: { label?: string }) {
  return (
    <div className="documents-paged-editor-canvas h-full min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain print:block print:!h-auto print:!overflow-visible print:!bg-white">
      <div className="documents-paged-inner pointer-events-auto mx-auto w-full max-w-full px-2 py-3 sm:px-3 sm:py-4 md:py-5">
        <div
          className="documents-paged-page-frame relative mx-auto"
          style={{ width: `${PAGE_WIDTH_PX / 96}in`, maxWidth: '100%' }}
          aria-busy="true"
          aria-label={label}
        >
          <div
            className="documents-paged-page-stack relative"
            style={{ minHeight: `${PAGE_HEIGHT_PX}px` }}
          >
            <div className="documents-paged-page-face documents-editor-paper pointer-events-none absolute left-0 top-0 h-[11in] w-full rounded-sm print:static print:h-auto print:shadow-none print:border-0" />
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

export default function DocumentsEditorPage() {
  const { docId } = useParams<{ docId: string }>()
  const navigate = useNavigate()
  const { user } = useUser()

  const { records: documents, status } = useQuery<DocumentsDocumentFields>('documents', {
    orderBy: 'createdAt',
    orderDir: 'desc',
  })

  const selectedDoc = useMemo(
    () => (docId ? documents.find((d) => d.recordId === docId) : null),
    [documents, docId],
  )

  const { put, ready: documentsMutationsReady } = useMutations<DocumentsDocumentFields>('documents')
  const documentWritesReady = recordsReadyForMutation(status, documentsMutationsReady)

  // The text helper remains available to consumers of useYjsRoom; this editor
  // binds Tiptap directly to Y.XmlFragment('default') on the returned document.
  const { doc, synced, connected, canWrite, writeAuthResolved, awareness } = useYjsRoom(
    docId ?? 'noop',
    'content',
  )

  const presenceAccess = useDocumentsPresenceAccess({
    docId,
    document: selectedDoc,
    user,
    yjsCanWrite: canWrite,
    writeAuthResolved,
  })
  const {
    isOwner,
    effectiveRole,
    effectiveCanWrite,
    showReadOnlyDocUx,
    accessChangeKind,
    handleAclChange,
  } = presenceAccess

  const [inviteOpen, setInviteOpen] = useState(false)

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

  const { participants: presenceParticipants, typingNames } = useDocumentsEditorPresence({
    editor,
    document: selectedDoc,
    user,
    synced,
    access: presenceAccess,
  })

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
      if (!documentWritesReady || !selectedDoc) return
      await put(selectedDoc.recordId, { ...selectedDoc.data, title: next }).catch(() => {})
    },
    [documentWritesReady, put, selectedDoc],
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
      className="documents-feature-scope flex h-full flex-col overflow-hidden print:h-auto print:overflow-visible"
      style={{ backgroundColor: 'var(--documents-el-bg)', color: 'var(--documents-el-text)' }}
    >
      <header
        className="relative z-10 flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-3 backdrop-blur-sm print:hidden sm:gap-3 sm:px-4"
        style={{
          borderColor: 'var(--documents-el-line)',
          backgroundColor: 'color-mix(in srgb, var(--documents-el-surface) 92%, transparent)',
        }}
      >
        <button
          type="button"
          onClick={() => navigate('/documents')}
          className="rounded-lg p-1.5 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          style={{ color: 'var(--documents-el-muted)' }}
          title="Back to documents"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2} />
        </button>

        <InlineTitle
          title={docTitle}
          canEdit={Boolean(isOwner && documentWritesReady)}
          onSave={handleTitleSave}
        />

        <DocumentsPresence participants={presenceParticipants} typingNames={typingNames} />

        <div className="flex shrink-0 items-center gap-3">
          {isOwner ? (
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
              style={{
                borderColor: 'var(--documents-el-line)',
                color: 'var(--documents-el-muted)',
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
              style={{
                borderColor: 'var(--documents-el-line)',
                color: 'var(--documents-el-muted)',
              }}
            >
              {effectiveRole === 'editor' ? 'Shared editor' : 'Shared viewer'}
            </span>
          ) : null}
          {connected && synced ? (
            <span
              className="flex items-center gap-1.5 text-xs tabular-nums"
              style={{ color: 'var(--documents-el-muted)' }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
              Synced
            </span>
          ) : connected ? (
            <span
              className="flex items-center gap-1.5 text-xs tabular-nums"
              style={{ color: 'var(--documents-el-muted)' }}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden />
              Connecting…
            </span>
          ) : (
            <span
              className="flex items-center gap-1.5 text-xs tabular-nums"
              style={{ color: 'var(--documents-el-muted)' }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden />
              Offline
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
            borderColor: 'var(--documents-el-line)',
            backgroundColor: 'color-mix(in srgb, var(--documents-el-muted) 12%, transparent)',
            color: 'var(--documents-el-muted)',
          }}
        >
          {effectiveRole === 'viewer'
            ? 'You have view-only access to this document. Ask the owner for editor access.'
            : 'You are viewing this document in read-only mode.'}
        </div>
      ) : null}

      <DocumentsTiptapToolbar
        editor={editor}
        disabled={!synced || !effectiveCanWrite}
        canvasZoom={canvasZoom}
        onCanvasZoomChange={(z) => setCanvasZoom(normalizeZoom(z))}
      />

      <div className="relative flex min-h-0 flex-1 flex-col print:block">
        {outlineOpen ? (
          <DocumentsOutlinePanel entries={outlineEntries} onJumpTo={jumpToHeading} />
        ) : null}

        <button
          type="button"
          data-testid="toggle-outline"
          onClick={() => setOutlineOpen((o) => !o)}
          title={outlineOpen ? 'Hide document outline' : 'Show document outline'}
          style={{
            top: 12,
            left: outlineOpen ? DOCUMENT_OUTLINE_WIDTH_PX + 10 : 12,
            borderColor: 'color-mix(in srgb, var(--documents-el-line) 85%, transparent)',
            backgroundColor: 'color-mix(in srgb, var(--documents-el-surface) 92%, transparent)',
            color: 'var(--documents-el-muted)',
          }}
          className={`absolute z-[36] flex h-9 w-9 items-center justify-center rounded-full border shadow-md backdrop-blur-md transition-[left,box-shadow,color] duration-200 ease-out hover:bg-black/[0.06] hover:text-[color:var(--documents-el-text)] hover:shadow-lg print:hidden dark:border-white/12 dark:hover:bg-white/[0.08] ${outlineOpen ? 'text-[color:var(--documents-el-text)]' : ''}`}
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
            <div className="documents-paged-editor-canvas flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center gap-4 px-6">
              <p className="text-sm" style={{ color: 'var(--documents-el-muted)' }}>
                This document is private. Ask the owner for an invite.
              </p>
              <button
                type="button"
                onClick={() => navigate('/documents')}
                className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: 'var(--documents-el-accent)' }}
              >
                Back to documents
              </button>
            </div>
          ) : editor && !docResolutionPending ? (
            <DocEditorSurface editor={editor} />
          ) : (
            <DocumentsEditorLoadingSurface
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
      data-testid="documents-route-error"
      className="documents-feature-scope flex h-full flex-col items-center justify-center px-6 text-center"
      style={{ backgroundColor: 'var(--documents-el-bg)', color: 'var(--documents-el-text)' }}
    >
      <div
        className="w-full max-w-md rounded-xl border p-6 shadow-md"
        style={{
          borderColor: 'var(--documents-el-line)',
          backgroundColor: 'var(--documents-el-surface)',
        }}
      >
        <div className="mb-3 flex items-center justify-center">
          <span
            className="inline-flex h-10 w-10 items-center justify-center rounded-full"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--documents-el-accent) 14%, transparent)',
              color: 'var(--documents-el-accent)',
            }}
            aria-hidden
          >
            <AlertTriangle className="h-5 w-5" strokeWidth={2} />
          </span>
        </div>
        <h1 className="text-base font-semibold tracking-tight">This document needs to reload</h1>
        <p
          className="mx-auto mt-1.5 max-w-xs text-sm"
          style={{ color: 'var(--documents-el-muted)' }}
        >
          Your access to this document just changed. Refresh to load the latest version.
        </p>
        <p
          className="mx-auto mt-3 max-w-xs truncate text-xs"
          style={{ color: 'var(--documents-el-muted)' }}
          title={message}
        >
          {message}
        </p>
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            autoFocus
            onClick={() => window.location.reload()}
            data-testid="documents-route-error-refresh"
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--documents-el-accent)' }}
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2.25} />
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
}
