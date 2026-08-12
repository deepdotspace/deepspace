/**
 * DocumentsListPage — documents2-style library: sidebar, folders, favorites, grid/list.
 * New documents default to “Untitled Document”; rename in editor (no modal).
 */

import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RecordData } from 'deepspace'
import { useUser } from 'deepspace'
import { useQuery } from 'deepspace'
import { useMutations } from 'deepspace'
import { ROLES, type Role } from 'deepspace'
import {
  FileText,
  Plus,
  Trash2,
  LayoutGrid,
  LayoutList,
  SortAsc,
  Search,
  Star,
  Folder,
  ChevronRight,
  MoreVertical,
  Pencil,
} from 'lucide-react'
import { LibrarySidebar, readSidebarCollapsed, writeSidebarCollapsed } from './LibrarySidebar'
import {
  parseDocumentsIdList,
  recordsReadyForMutation,
  type DocFolderFields,
  type DocumentsDocumentFields,
  type LibraryNavSelection,
} from './documents-library-types'
import './documents-ui.css'

type SortOption = 'lastEdited' | 'titleAZ' | 'titleZA'
type ViewMode = 'grid' | 'list'

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'lastEdited', label: 'Last edited' },
  { value: 'titleAZ', label: 'Title A–Z' },
  { value: 'titleZA', label: 'Title Z–A' },
]

const UNTITLED = 'Untitled Document'
const FAVORITES_KEY = 'deepspace-documents-favorites'

function readFavorites(): Set<string> {
  try {
    const stored = localStorage.getItem(FAVORITES_KEY)
    return new Set(parseDocumentsIdList(stored ?? undefined))
  } catch {
    return new Set()
  }
}

function writeFavorites(favorites: Set<string>): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]))
  } catch {
    // Favorites are local convenience state; storage denial must not break UI state.
  }
}

function greetingForTime(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export default function DocumentsListPage() {
  const { user } = useUser()
  const navigate = useNavigate()
  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const roleCanCreate = userRole === ROLES.MEMBER || userRole === ROLES.ADMIN

  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortOption>('lastEdited')
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [sortOpen, setSortOpen] = useState(false)
  const [favorites, setFavorites] = useState<Set<string>>(readFavorites)
  const [libraryNav, setLibraryNav] = useState<LibraryNavSelection>({ kind: 'all' })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [folderRenamingId, setFolderRenamingId] = useState<string | null>(null)
  const [folderRenameValue, setFolderRenameValue] = useState('')
  const [moveMenuId, setMoveMenuId] = useState<string | null>(null)
  const [actionsMenuId, setActionsMenuId] = useState<string | null>(null)

  const { records: documents, status } = useQuery<DocumentsDocumentFields>('documents', {
    orderBy: 'createdAt',
    orderDir: 'desc',
  })
  const {
    createConfirmed,
    remove,
    put,
    ready: documentsMutationsReady,
  } = useMutations<DocumentsDocumentFields>('documents')

  const { records: folderRecords, status: foldersStatus } = useQuery<DocFolderFields>(
    'doc_folders',
    {
      orderBy: 'createdAt',
      orderDir: 'asc',
    },
  )
  const {
    create: createFolder,
    put: putFolder,
    remove: removeFolder,
    ready: folderMutationsReady,
  } = useMutations<DocFolderFields>('doc_folders')
  const documentWritesReady = recordsReadyForMutation(status, documentsMutationsReady)
  const folderWritesReady = recordsReadyForMutation(foldersStatus, folderMutationsReady)
  const canCreate = roleCanCreate && documentWritesReady
  const canManageFolders = canCreate && folderWritesReady
  const canMoveDocuments = canCreate && foldersStatus === 'ready'

  const myFolders = useMemo(
    () => (folderRecords ?? []).filter((f) => f.data.ownerId === user?.id),
    [folderRecords, user?.id],
  )
  const sortedFolders = useMemo(
    () => [...myFolders].sort((a, b) => (a.data.name ?? '').localeCompare(b.data.name ?? '')),
    [myFolders],
  )

  useEffect(() => {
    if (libraryNav.kind !== 'folder') return
    if (!sortedFolders.some((f) => f.recordId === libraryNav.folderId)) {
      setLibraryNav({ kind: 'all' })
    }
  }, [libraryNav, sortedFolders])

  const displayFirstName = user?.name?.trim().split(/\s+/)[0] ?? 'there'

  const isOwnedDocument = useCallback(
    (d: RecordData<DocumentsDocumentFields>) => d.data.ownerId === user?.id,
    [user?.id],
  )

  const isSharedWithCurrentUser = useCallback(
    (d: RecordData<DocumentsDocumentFields>) =>
      Boolean(
        user?.id &&
        d.data.ownerId !== user.id &&
        parseDocumentsIdList(d.data.collaborators).includes(user.id),
      ),
    [user?.id],
  )

  const ownedDocumentCount = useMemo(
    () => (documents ?? []).filter(isOwnedDocument).length,
    [documents, isOwnedDocument],
  )

  const listHeading = useMemo(() => {
    if (libraryNav.kind === 'shared') return 'Shared with me'
    if (libraryNav.kind === 'favorites') return 'Favorites'
    if (libraryNav.kind === 'uncategorized') return 'Uncategorized'
    if (libraryNav.kind === 'folder') {
      return (
        sortedFolders.find((f) => f.recordId === libraryNav.folderId)?.data.name?.trim() || 'Folder'
      )
    }
    return 'My Documents'
  }, [libraryNav, sortedFolders])

  const matchesNav = useCallback(
    (d: RecordData<DocumentsDocumentFields>) => {
      const fid = d.data.folderId ?? ''
      if (libraryNav.kind === 'all') return isOwnedDocument(d)
      if (libraryNav.kind === 'shared') return isSharedWithCurrentUser(d)
      if (libraryNav.kind === 'favorites') return favorites.has(d.recordId)
      if (libraryNav.kind === 'uncategorized') return isOwnedDocument(d) && fid === ''
      if (libraryNav.kind === 'folder') return isOwnedDocument(d) && fid === libraryNav.folderId
      return true
    },
    [favorites, isOwnedDocument, isSharedWithCurrentUser, libraryNav],
  )

  const filteredSorted = useMemo(() => {
    let rows = (documents ?? []).filter(matchesNav)
    const q = searchQuery.trim().toLowerCase()
    if (q) rows = rows.filter((d) => d.data.title.toLowerCase().includes(q))
    switch (sortBy) {
      case 'lastEdited':
        rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        break
      case 'titleAZ':
        rows.sort((a, b) => a.data.title.localeCompare(b.data.title))
        break
      case 'titleZA':
        rows.sort((a, b) => b.data.title.localeCompare(a.data.title))
        break
      default:
        break
    }
    return rows
  }, [documents, matchesNav, searchQuery, sortBy])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      const n = !c
      writeSidebarCollapsed(n)
      return n
    })
  }, [])

  const toggleFavorite = useCallback((contentId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(contentId)) next.delete(contentId)
      else next.add(contentId)
      writeFavorites(next)
      return next
    })
  }, [])

  const folderIdForNew = libraryNav.kind === 'folder' ? libraryNav.folderId : ''

  const handleNewDocument = useCallback(async () => {
    if (!user || !canCreate) return
    const id = await createConfirmed({
      title: UNTITLED,
      ownerId: user.id,
      collaborators: '[]',
      editors: '[]',
      folderId: folderIdForNew,
    })
    navigate(`/documents/${id}`)
  }, [canCreate, createConfirmed, folderIdForNew, navigate, user])

  const handleDelete = useCallback(
    async (docId: string) => {
      if (!canCreate) return
      if (confirm('Delete this document?')) await remove(docId)
    },
    [canCreate, remove],
  )

  const handleRenameCommit = useCallback(
    async (docId: string) => {
      if (!canCreate) {
        setRenamingId(null)
        return
      }
      const rec = documents.find((d) => d.recordId === docId)
      const t = renameValue.trim()
      setRenamingId(null)
      if (!rec || !t || t === rec.data.title) return
      await put(docId, { ...rec.data, title: t }).catch(() => {})
    },
    [canCreate, documents, put, renameValue],
  )

  const handleCreateFolder = useCallback(
    async (name: string) => {
      if (!user || !canManageFolders) return
      await createFolder({ name, ownerId: user.id })
    },
    [canManageFolders, createFolder, user],
  )

  const handleDeleteFolder = useCallback(
    async (folderId: string) => {
      if (!canManageFolders) return
      const owned = (documents ?? []).filter(
        (d) => d.data.ownerId === user?.id && (d.data.folderId ?? '') === folderId,
      )
      await Promise.all(owned.map((d) => put(d.recordId, { ...d.data, folderId: '' })))
      await removeFolder(folderId)
      setFolderRenamingId((id) => (id === folderId ? null : id))
      setLibraryNav((nav) =>
        nav.kind === 'folder' && nav.folderId === folderId ? { kind: 'all' } : nav,
      )
    },
    [canManageFolders, documents, put, removeFolder, user?.id],
  )

  const commitRenameFolderRef = useRef<() => Promise<void>>(async () => {})
  const commitRenameFolder = useCallback(async () => {
    const id = folderRenamingId
    const trimmed = folderRenameValue.trim()
    setFolderRenamingId(null)
    if (!canManageFolders || !id || !trimmed) return
    const folder = sortedFolders.find((f) => f.recordId === id)
    if (!folder || trimmed === (folder.data.name ?? '').trim()) return
    await putFolder(id, { ...folder.data, name: trimmed }).catch(() => {})
  }, [canManageFolders, folderRenameValue, folderRenamingId, putFolder, sortedFolders])

  commitRenameFolderRef.current = commitRenameFolder

  const handleMoveDoc = useCallback(
    async (docId: string, folderId: string) => {
      if (!canMoveDocuments) return
      const rec = documents.find((d) => d.recordId === docId)
      if (!rec) return
      await put(docId, { ...rec.data, folderId })
      setMoveMenuId(null)
    },
    [canMoveDocuments, documents, put],
  )

  const isLoading = status === 'loading'

  const accentBtn =
    'inline-flex h-9 items-center gap-2 rounded-lg px-4 text-[12px] font-bold text-white shadow-sm transition-opacity hover:opacity-90'
  const ghostBtn =
    'inline-flex h-9 items-center gap-2 rounded-lg border px-4 text-[12px] font-semibold shadow-sm transition-colors'

  const blankWhen =
    canCreate &&
    libraryNav.kind !== 'favorites' &&
    (libraryNav.kind === 'all' ||
      libraryNav.kind === 'uncategorized' ||
      libraryNav.kind === 'folder')

  return (
    <div
      className="documents-feature-scope flex min-h-full overflow-hidden"
      style={{ backgroundColor: 'var(--documents-el-bg)', color: 'var(--documents-el-text)' }}
    >
      {user ? (
        <LibrarySidebar
          selection={libraryNav}
          onSelect={setLibraryNav}
          folders={myFolders}
          canManageFolders={canManageFolders}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
          onCreateFolder={handleCreateFolder}
          onDeleteFolder={handleDeleteFolder}
          onStartRenameFolder={(f) => {
            setFolderRenamingId(f.recordId)
            setFolderRenameValue(f.data.name ?? '')
          }}
          renamingFolderId={folderRenamingId}
          renameFolderValue={folderRenameValue}
          setRenameFolderValue={setFolderRenameValue}
          onCommitRenameFolder={() => commitRenameFolderRef.current()}
          onCancelRenameFolder={() => setFolderRenamingId(null)}
        />
      ) : null}

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="px-6 pb-10 pt-9 md:px-12 md:pb-12 md:pt-10 lg:px-16 lg:pb-16 lg:pt-12">
          <div className="mb-1 flex min-w-0 items-center justify-between gap-4">
            <h1
              className="min-w-0 text-3xl font-bold leading-tight tracking-tight sm:text-4xl"
              style={{ color: 'var(--documents-el-text)' }}
            >
              {greetingForTime()}, {displayFirstName}
            </h1>
          </div>
          <p
            className="mb-8 text-[13px] font-medium"
            style={{ color: 'var(--documents-el-muted)' }}
          >
            {ownedDocumentCount} {ownedDocumentCount === 1 ? 'document' : 'documents'} in your
            documents.
          </p>

          <div className="mb-8 flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 max-w-md flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
                style={{ color: 'var(--documents-el-muted)' }}
                strokeWidth={2}
                aria-hidden
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search your library..."
                className="h-auto w-full rounded-lg py-2 pl-10 pr-10 text-[13px] shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                style={{
                  backgroundColor: 'var(--documents-el-surface)',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--documents-el-line)',
                  color: 'var(--documents-el-text)',
                }}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px] font-medium"
                  style={{ color: 'var(--documents-el-muted)' }}
                  onClick={() => setSearchQuery('')}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 sm:ml-auto">
              {canCreate ? (
                <button
                  type="button"
                  onClick={() => void handleNewDocument()}
                  className={accentBtn}
                  style={{ backgroundColor: 'var(--documents-el-accent)' }}
                >
                  <Plus className="h-4 w-4" strokeWidth={2.5} />
                  New Document
                </button>
              ) : null}
            </div>
          </div>

          {canCreate && sortedFolders.length > 0 && (
            <div className="mb-10 grid grid-cols-1 gap-3 md:grid-cols-4">
              {sortedFolders.map((folder) => {
                const selected =
                  libraryNav.kind === 'folder' && libraryNav.folderId === folder.recordId
                return (
                  <button
                    key={folder.recordId}
                    type="button"
                    onClick={() => setLibraryNav({ kind: 'folder', folderId: folder.recordId })}
                    className="group flex min-w-0 items-center rounded-xl border p-3.5 text-left shadow-sm transition-all"
                    style={{
                      borderColor: selected
                        ? 'color-mix(in srgb, var(--documents-el-accent) 50%, transparent)'
                        : 'var(--documents-el-line)',
                      backgroundColor: 'var(--documents-el-surface)',
                      boxShadow: selected
                        ? '0 0 0 2px color-mix(in srgb, var(--documents-el-accent) 15%, transparent)'
                        : undefined,
                    }}
                  >
                    <div
                      className="rounded-lg p-2 transition-all group-hover:bg-[color-mix(in_srgb,var(--documents-el-accent)_5%,transparent)]"
                      style={{
                        backgroundColor: 'var(--documents-el-bg)',
                        color: 'var(--documents-el-muted)',
                      }}
                    >
                      <Folder className="h-4 w-4" />
                    </div>
                    <span className="min-w-0 flex-1 truncate pl-3 text-[13px] font-semibold">
                      {folder.data.name}
                    </span>
                    <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                  </button>
                )
              })}
            </div>
          )}

          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <h2
              className="text-[11px] font-bold uppercase tracking-widest"
              style={{ color: 'var(--documents-el-muted)' }}
            >
              {listHeading}
            </h2>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSortOpen(!sortOpen)}
                  className={ghostBtn}
                  style={{
                    borderColor: 'var(--documents-el-line)',
                    backgroundColor: 'var(--documents-el-surface)',
                    color: 'var(--documents-el-muted)',
                  }}
                >
                  <SortAsc className="h-3.5 w-3.5" />
                  {SORT_OPTIONS.find((o) => o.value === sortBy)?.label}
                </button>
                {sortOpen ? (
                  <>
                    <button
                      type="button"
                      className="fixed inset-0 z-40 cursor-default bg-transparent"
                      aria-label="Close menu"
                      onClick={() => setSortOpen(false)}
                    />
                    <div
                      className="absolute right-0 top-full z-50 mt-1 min-w-[168px] rounded-lg border py-1 shadow-lg"
                      style={{
                        borderColor: 'var(--documents-el-line)',
                        backgroundColor: 'var(--documents-el-surface)',
                      }}
                    >
                      {SORT_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => {
                            setSortBy(opt.value)
                            setSortOpen(false)
                          }}
                          className="w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                          style={{
                            color:
                              sortBy === opt.value
                                ? 'var(--documents-el-accent)'
                                : 'var(--documents-el-text)',
                            fontWeight: sortBy === opt.value ? 600 : 400,
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>

              <div
                className="flex items-center rounded-lg p-0.5"
                style={{
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--documents-el-line)',
                  backgroundColor: 'color-mix(in srgb, var(--documents-el-text) 5%, transparent)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className="rounded-md p-1.5 transition-all"
                  style={
                    viewMode === 'grid'
                      ? {
                          backgroundColor: 'var(--documents-el-surface)',
                          color: 'var(--documents-el-text)',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                        }
                      : { color: 'var(--documents-el-muted)' }
                  }
                  title="Grid view"
                >
                  <LayoutGrid className="h-[13px] w-[13px]" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className="rounded-md p-1.5 transition-all"
                  style={
                    viewMode === 'list'
                      ? {
                          backgroundColor: 'var(--documents-el-surface)',
                          color: 'var(--documents-el-text)',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                        }
                      : { color: 'var(--documents-el-muted)' }
                  }
                  title="List view"
                >
                  <LayoutList className="h-[13px] w-[13px]" />
                </button>
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <div
                className="h-10 w-10 animate-spin rounded-full border-2"
                style={{
                  borderColor: 'var(--documents-el-line)',
                  borderTopColor: 'var(--documents-el-accent)',
                }}
              />
            </div>
          ) : filteredSorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
              <div
                className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
                style={{
                  backgroundColor: 'var(--documents-el-surface)',
                  boxShadow:
                    '0 0 0 1px var(--documents-el-line), 0 1px 2px color-mix(in srgb, var(--documents-el-text) 8%, transparent)',
                }}
              >
                <FileText
                  className="h-8 w-8"
                  strokeWidth={1.5}
                  style={{ color: 'var(--documents-el-muted)' }}
                  aria-hidden
                />
              </div>
              <h3
                className="mb-2 text-lg font-semibold"
                style={{ color: 'var(--documents-el-text)' }}
              >
                {searchQuery ? 'No matches' : 'No documents yet'}
              </h3>
              <p className="mb-6 max-w-sm text-sm" style={{ color: 'var(--documents-el-muted)' }}>
                {canCreate && !searchQuery
                  ? 'Create your first document with New Document above'
                  : searchQuery
                    ? 'Try a different search'
                    : 'No documents yet'}
              </p>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
              {blankWhen ? (
                <button
                  type="button"
                  onClick={() => void handleNewDocument()}
                  className="group w-full cursor-pointer rounded-xl border-2 border-dashed p-4 text-left shadow-sm transition-all hover:shadow-md"
                  style={{
                    borderColor: 'var(--documents-el-line)',
                    backgroundColor:
                      'color-mix(in srgb, var(--documents-el-surface) 20%, transparent)',
                  }}
                >
                  <div
                    className="relative mb-4 aspect-[3/4] w-full overflow-hidden rounded-lg border shadow-sm"
                    style={{
                      borderColor: 'var(--documents-el-line)',
                      backgroundColor: 'var(--documents-el-bg)',
                    }}
                  >
                    <div className="flex h-full w-full items-center justify-center">
                      <div
                        className="flex h-10 w-10 items-center justify-center rounded-full ring-1 transition-colors group-hover:text-[color:var(--documents-el-accent)]"
                        style={{
                          backgroundColor: 'var(--documents-el-surface)',
                          color: 'var(--documents-el-muted)',
                          boxShadow: '0 0 0 1px var(--documents-el-line)',
                        }}
                      >
                        <Plus className="h-5 w-5" strokeWidth={2.5} />
                      </div>
                    </div>
                  </div>
                  <h3
                    className="truncate text-[13px] font-semibold leading-snug transition-colors group-hover:text-[color:var(--documents-el-accent)]"
                    style={{ color: 'var(--documents-el-text)' }}
                  >
                    Blank doc
                  </h3>
                  <p
                    className="mt-0.5 text-[10px] font-medium"
                    style={{ color: 'var(--documents-el-muted)' }}
                  >
                    Creates “{UNTITLED}” — rename in editor
                  </p>
                </button>
              ) : null}

              {filteredSorted.map((doc) => {
                const isOwner = doc.data.ownerId === user?.id
                const isFav = favorites.has(doc.recordId)
                const dateLabel = formatDate(doc.createdAt)
                const fid = doc.data.folderId ?? ''

                return (
                  <div
                    key={doc.recordId}
                    role="button"
                    tabIndex={0}
                    className="group relative cursor-pointer rounded-xl border p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
                    style={{
                      borderColor: 'var(--documents-el-line)',
                      backgroundColor: 'var(--documents-el-surface)',
                    }}
                    onClick={() => navigate(`/documents/${doc.recordId}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigate(`/documents/${doc.recordId}`)
                      }
                    }}
                  >
                    <div
                      className="relative mb-4 aspect-[3/4] w-full overflow-hidden rounded-lg border shadow-sm"
                      style={{
                        borderColor: 'var(--documents-el-line)',
                        backgroundColor: 'var(--documents-el-bg)',
                      }}
                    >
                      <div className="flex h-full w-full items-center justify-center">
                        <FileText className="h-10 w-10 opacity-[0.18]" strokeWidth={1.25} />
                      </div>
                    </div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        {renamingId === doc.recordId ? (
                          <input
                            disabled={!canCreate}
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => void handleRenameCommit(doc.recordId)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleRenameCommit(doc.recordId)
                              if (e.key === 'Escape') setRenamingId(null)
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="mb-0.5 w-full rounded-md border px-2 py-1 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                            style={{
                              borderColor: 'var(--documents-el-line)',
                              backgroundColor: 'var(--documents-el-bg)',
                              color: 'var(--documents-el-text)',
                            }}
                            autoFocus
                          />
                        ) : (
                          <h3
                            className="truncate text-[13px] font-semibold leading-snug transition-colors group-hover:text-[color:var(--documents-el-accent)]"
                            style={{ color: 'var(--documents-el-text)' }}
                          >
                            {doc.data.title}
                          </h3>
                        )}
                        <p
                          className="mt-0.5 text-[10px] font-medium leading-4 tracking-tight"
                          style={{ color: 'var(--documents-el-muted)' }}
                        >
                          {dateLabel}
                          {isOwner ? ' · You' : ''}
                          {!isOwner ? ' · Shared with you' : ''}
                          {fid
                            ? ` · ${sortedFolders.find((f) => f.recordId === fid)?.data.name ?? 'Folder'}`
                            : ''}
                        </p>
                      </div>
                      {isOwner ? (
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            title={isFav ? 'Remove favorite' : 'Add favorite'}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleFavorite(doc.recordId)
                            }}
                            className="rounded-lg p-1.5 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                            style={{ color: 'var(--documents-el-muted)' }}
                          >
                            <Star
                              className={`h-4 w-4 ${isFav ? 'fill-yellow-500 text-yellow-500' : ''}`}
                            />
                          </button>
                          <div className="relative">
                            <button
                              type="button"
                              title="More"
                              disabled={!canCreate}
                              onClick={(e) => {
                                e.stopPropagation()
                                setActionsMenuId((id) =>
                                  id === doc.recordId ? null : doc.recordId,
                                )
                                setMoveMenuId(null)
                              }}
                              className="rounded-lg p-1.5 disabled:cursor-not-allowed disabled:opacity-40"
                              style={{ color: 'var(--documents-el-muted)' }}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                            {canCreate && actionsMenuId === doc.recordId ? (
                              <>
                                <button
                                  type="button"
                                  className="fixed inset-0 z-40 cursor-default bg-transparent"
                                  aria-label="Close"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setActionsMenuId(null)
                                  }}
                                />
                                <div
                                  className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-lg border py-1 shadow-lg"
                                  style={{
                                    borderColor: 'var(--documents-el-line)',
                                    backgroundColor: 'var(--documents-el-surface)',
                                    color: 'var(--documents-el-text)',
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                                    onClick={() => {
                                      setRenamingId(doc.recordId)
                                      setRenameValue(doc.data.title)
                                      setActionsMenuId(null)
                                    }}
                                  >
                                    <Pencil className="h-3.5 w-3.5" /> Rename
                                  </button>
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                                    onClick={() => {
                                      setMoveMenuId(
                                        moveMenuId === doc.recordId ? null : doc.recordId,
                                      )
                                    }}
                                  >
                                    <Folder className="h-3.5 w-3.5" /> Move to…
                                  </button>
                                  {moveMenuId === doc.recordId ? (
                                    <div
                                      className="border-t px-2 py-1"
                                      style={{ borderColor: 'var(--documents-el-line)' }}
                                    >
                                      <button
                                        type="button"
                                        className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-black/[0.04]"
                                        disabled={!canMoveDocuments || fid === ''}
                                        onClick={() => void handleMoveDoc(doc.recordId, '')}
                                      >
                                        Uncategorized
                                      </button>
                                      {sortedFolders.map((f) => (
                                        <button
                                          key={f.recordId}
                                          type="button"
                                          disabled={!canMoveDocuments || fid === f.recordId}
                                          className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-black/[0.04] disabled:opacity-40"
                                          onClick={() =>
                                            void handleMoveDoc(doc.recordId, f.recordId)
                                          }
                                        >
                                          {f.data.name}
                                        </button>
                                      ))}
                                    </div>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-500/10"
                                    onClick={() => {
                                      setActionsMenuId(null)
                                      void handleDelete(doc.recordId)
                                    }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" /> Delete
                                  </button>
                                </div>
                              </>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div
              className="overflow-hidden rounded-xl border shadow-sm"
              style={{
                borderColor: 'var(--documents-el-line)',
                backgroundColor: 'var(--documents-el-surface)',
              }}
            >
              <div
                className="flex items-center gap-4 border-b px-4 py-2 text-[10px] font-bold uppercase tracking-widest"
                style={{
                  borderColor: 'var(--documents-el-line)',
                  backgroundColor: 'color-mix(in srgb, var(--documents-el-text) 3%, transparent)',
                  color: 'var(--documents-el-muted)',
                }}
              >
                <div className="min-w-0 flex-1">Name</div>
                <div className="hidden w-28 shrink-0 md:block">Folder</div>
                <div className="hidden w-36 shrink-0 text-right md:block">Modified</div>
                <div className="w-24 shrink-0" />
              </div>
              {filteredSorted.map((doc) => {
                const isOwner = doc.data.ownerId === user?.id
                const isFav = favorites.has(doc.recordId)
                const dateLabel = formatDate(doc.createdAt)
                const fid = doc.data.folderId ?? ''
                const folderLabel = fid
                  ? (sortedFolders.find((f) => f.recordId === fid)?.data.name ?? '—')
                  : '—'

                return (
                  <div
                    key={doc.recordId}
                    role="button"
                    tabIndex={0}
                    className="group flex cursor-pointer items-center gap-4 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                    style={{ borderColor: 'var(--documents-el-line)' }}
                    onClick={() => navigate(`/documents/${doc.recordId}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigate(`/documents/${doc.recordId}`)
                      }
                    }}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-4">
                      <div
                        className="hidden h-14 w-11 shrink-0 overflow-hidden rounded-md border sm:block"
                        style={{
                          borderColor: 'var(--documents-el-line)',
                          backgroundColor: 'var(--documents-el-bg)',
                        }}
                      >
                        <div className="flex h-full w-full items-center justify-center">
                          <FileText className="h-5 w-5 opacity-25" />
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <h4
                          className="line-clamp-2 text-[13px] font-semibold leading-snug transition-colors group-hover:text-[color:var(--documents-el-accent)]"
                          style={{ color: 'var(--documents-el-text)' }}
                        >
                          {doc.data.title}
                        </h4>
                        <p
                          className="mt-0.5 text-[10px] font-medium md:hidden"
                          style={{ color: 'var(--documents-el-muted)' }}
                        >
                          {dateLabel}
                          {isOwner ? ' · You' : ' · Shared with you'}
                          {folderLabel !== '—' ? ` · ${folderLabel}` : ''}
                        </p>
                      </div>
                    </div>
                    <div
                      className="hidden w-28 shrink-0 truncate text-[12px] md:block"
                      style={{ color: 'var(--documents-el-muted)' }}
                    >
                      {folderLabel}
                    </div>
                    <div
                      className="hidden w-36 shrink-0 text-right text-[12px] md:block"
                      style={{ color: 'var(--documents-el-muted)' }}
                    >
                      {dateLabel}
                    </div>
                    <div className="flex w-24 shrink-0 justify-end gap-1">
                      {isOwner ? (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleFavorite(doc.recordId)
                            }}
                            className="rounded-lg p-1.5"
                            style={{ color: 'var(--documents-el-muted)' }}
                          >
                            <Star
                              className={`h-4 w-4 ${isFav ? 'fill-yellow-500 text-yellow-500' : ''}`}
                            />
                          </button>
                          <button
                            type="button"
                            disabled={!canCreate}
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDelete(doc.recordId)
                            }}
                            className="rounded-lg p-1.5 opacity-0 transition-opacity group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                            style={{ color: 'var(--documents-el-muted)' }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
