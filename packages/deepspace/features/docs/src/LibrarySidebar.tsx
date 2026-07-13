/**
 * Etheris-style library sidebar — nav + folders (docs2-aligned UI).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import type { RecordData } from 'deepspace'
import {
  FileText,
  Folder,
  FolderPlus,
  LayoutGrid,
  PanelLeftClose,
  Pencil,
  Star,
  Trash2,
  Users,
} from 'lucide-react'
import type { DocFolderFields, LibraryNavSelection } from './docs-library-types'

const SIDEBAR_COLLAPSED_KEY = 'deepspace-docs-library-sidebar-collapsed'

export function readSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function NavRow({
  active,
  icon: Icon,
  label,
  onClick,
  testId,
  trailing,
  collapsed,
}: {
  active: boolean
  icon: typeof FileText
  label: string
  onClick: () => void
  testId?: string
  trailing?: ReactNode
  collapsed?: boolean
}) {
  return (
    <div className="group flex w-full min-w-0 items-center gap-0.5">
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        title={collapsed ? label : undefined}
        className={`flex h-9 min-w-0 flex-1 items-center gap-0 rounded-md pl-0.5 pr-0 text-left text-[13px] ${
          active
            ? 'bg-[color:var(--docs-el-accent)] font-medium text-white shadow-sm'
            : 'text-[color:var(--docs-el-text)]/80 transition-colors hover:bg-black/[0.04] hover:text-[color:var(--docs-el-text)] dark:hover:bg-white/[0.06]'
        }`}
      >
        <span className="flex h-9 w-10 shrink-0 items-center justify-center" aria-hidden>
          <Icon size={14} strokeWidth={active ? 2.5 : 1.8} className="shrink-0" />
        </span>
        <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate pr-2'}>{label}</span>
      </button>
      {!collapsed && trailing}
    </div>
  )
}

const FOLDER_RENAME_BLUR_DEFER_MS = 200
const FOLDER_RENAME_BLUR_GRACE_MS = 520

function SidebarFolderRenameField({
  folderId,
  renameFolderValue,
  setRenameFolderValue,
  onCommitFolderRenameRef,
  onCancelRenameFolder,
  blurTimerRef,
  sessionStartRef,
  testId,
}: {
  folderId: string
  renameFolderValue: string
  setRenameFolderValue: (v: string) => void
  onCommitFolderRenameRef: MutableRefObject<() => void | Promise<void>>
  onCancelRenameFolder: () => void
  blurTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  sessionStartRef: MutableRefObject<number>
  testId: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now()
    sessionStartRef.current = t
    const el = inputRef.current
    if (!el) return
    const placeCaretAtEnd = () => {
      const len = el.value.length
      el.setSelectionRange(len, len)
    }
    el.focus({ preventScroll: true })
    placeCaretAtEnd()
    const raf = requestAnimationFrame(() => {
      if (document.activeElement !== el) {
        el.focus({ preventScroll: true })
        placeCaretAtEnd()
      }
    })
    return () => cancelAnimationFrame(raf)
    // sessionStartRef is a stable ref (only written here); listing it is a no-op
    // but satisfies the rule without changing re-run behavior.
  }, [folderId, sessionStartRef])

  return (
    <input
      ref={inputRef}
      value={renameFolderValue}
      onChange={(e) => setRenameFolderValue(e.target.value)}
      onFocus={() => {
        if (blurTimerRef.current) {
          clearTimeout(blurTimerRef.current)
          blurTimerRef.current = null
        }
      }}
      onBlur={() => {
        if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
        blurTimerRef.current = setTimeout(() => {
          blurTimerRef.current = null
          const t0 = sessionStartRef.current
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
          if (now - t0 < FOLDER_RENAME_BLUR_GRACE_MS) return
          void onCommitFolderRenameRef.current()
        }, FOLDER_RENAME_BLUR_DEFER_MS)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (blurTimerRef.current) {
            clearTimeout(blurTimerRef.current)
            blurTimerRef.current = null
          }
          void onCommitFolderRenameRef.current()
        }
        if (e.key === 'Escape') {
          if (blurTimerRef.current) {
            clearTimeout(blurTimerRef.current)
            blurTimerRef.current = null
          }
          onCancelRenameFolder()
        }
      }}
      data-testid={testId}
      className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      style={{
        borderColor: 'var(--docs-el-line)',
        backgroundColor: 'var(--docs-el-bg)',
        color: 'var(--docs-el-text)',
      }}
    />
  )
}

export interface LibrarySidebarProps {
  selection: LibraryNavSelection
  onSelect: (s: LibraryNavSelection) => void
  folders: RecordData<DocFolderFields>[]
  collapsed: boolean
  onToggleCollapsed: () => void
  onCreateFolder: (name: string) => void | Promise<void>
  onDeleteFolder: (folderId: string) => void | Promise<void>
  onStartRenameFolder: (folder: RecordData<DocFolderFields>) => void
  renamingFolderId: string | null
  renameFolderValue: string
  setRenameFolderValue: (v: string) => void
  onCommitRenameFolder: () => void | Promise<void>
  onCancelRenameFolder: () => void
}

export function LibrarySidebar({
  selection,
  onSelect,
  folders,
  collapsed,
  onToggleCollapsed,
  onCreateFolder,
  onDeleteFolder,
  onStartRenameFolder,
  renamingFolderId,
  renameFolderValue,
  setRenameFolderValue,
  onCommitRenameFolder,
  onCancelRenameFolder,
}: LibrarySidebarProps) {
  const [addingFolder, setAddingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const folderRenameBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const folderRenameSessionStartRef = useRef(0)
  const onCommitFolderRenameRef = useRef(onCommitRenameFolder)
  onCommitFolderRenameRef.current = onCommitRenameFolder

  useEffect(() => {
    return () => {
      // Intentionally read the ref's LATEST value at unmount to clear whatever
      // blur timer is pending; capturing it at effect-setup time (null) would be
      // wrong here since this is a timer ref, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- must clear the latest pending timer at unmount, not the setup-time value
      if (folderRenameBlurTimerRef.current) clearTimeout(folderRenameBlurTimerRef.current)
    }
  }, [])

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim()
    if (!name) {
      setAddingFolder(false)
      setNewFolderName('')
      return
    }
    await onCreateFolder(name)
    setNewFolderName('')
    setAddingFolder(false)
  }, [newFolderName, onCreateFolder])

  const sortedFolders = [...folders].sort((a, b) =>
    (a.data.name ?? '').localeCompare(b.data.name ?? ''),
  )

  return (
    <aside
      data-testid="library-sidebar"
      className={`relative z-20 box-border shrink-0 overflow-x-clip border-r backdrop-blur-xl transition-[width] duration-200 ease-out will-change-[width] ${
        collapsed ? 'w-16' : 'w-64'
      }`}
      style={{
        borderColor: 'var(--docs-el-line)',
        backgroundColor: 'color-mix(in srgb, var(--docs-el-surface) 92%, transparent)',
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div
          className={`relative flex min-h-14 w-full min-w-0 items-center overflow-hidden border-b py-3 pl-3.5 ${
            collapsed ? 'pr-2.5' : 'pr-12'
          }`}
          style={{ borderColor: 'var(--docs-el-line)' }}
        >
          <div
            className={`flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden ${
              collapsed ? 'pointer-events-none select-none opacity-0' : ''
            }`}
            aria-hidden={collapsed}
          >
            <div className="flex h-8 w-9 shrink-0 items-center justify-center" aria-hidden>
              <FileText className="text-blue-600 dark:text-blue-400" size={26} strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <span className="block truncate text-base font-bold leading-tight tracking-tight text-[color:var(--docs-el-text)]">
                Documents
              </span>
              <span className="block truncate text-[10px] font-semibold uppercase tracking-widest text-[color:var(--docs-el-muted)]/75">
                Workspace
              </span>
            </div>
          </div>
          <button
            type="button"
            data-testid="library-sidebar-collapse"
            onClick={onToggleCollapsed}
            className="absolute right-2.5 top-1/2 z-10 flex h-8 w-9 -translate-y-1/2 items-center justify-center rounded-md transition-colors hover:bg-black/[0.04] hover:text-[color:var(--docs-el-text)] dark:hover:bg-white/[0.06]"
            style={{ color: 'var(--docs-el-muted)' }}
            title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
            aria-expanded={!collapsed}
          >
            <PanelLeftClose
              className="h-4 w-4"
              style={{ transform: collapsed ? 'scaleX(-1)' : undefined }}
            />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto py-4 pl-3.5 pr-1.5">
          <NavRow
            active={selection.kind === 'all'}
            icon={LayoutGrid}
            label="Library"
            testId="library-nav-all"
            onClick={() => onSelect({ kind: 'all' })}
            collapsed={collapsed}
          />
          <NavRow
            active={selection.kind === 'shared'}
            icon={Users}
            label="Shared with me"
            testId="library-nav-shared"
            onClick={() => onSelect({ kind: 'shared' })}
            collapsed={collapsed}
          />
          <NavRow
            active={selection.kind === 'favorites'}
            icon={Star}
            label="Favorites"
            testId="library-nav-favorites"
            onClick={() => onSelect({ kind: 'favorites' })}
            collapsed={collapsed}
          />
          <NavRow
            active={selection.kind === 'uncategorized'}
            icon={FileText}
            label="Uncategorized"
            testId="library-nav-uncategorized"
            onClick={() => onSelect({ kind: 'uncategorized' })}
            collapsed={collapsed}
          />

          <div className="mt-8 border-t pt-3" style={{ borderColor: 'var(--docs-el-line)' }}>
            <span
              className={`mb-2 block pl-2.5 pr-0 text-[10px] font-bold uppercase tracking-widest text-[color:var(--docs-el-muted)]/80 ${
                collapsed ? 'pointer-events-none select-none opacity-0' : ''
              }`}
              aria-hidden={collapsed}
            >
              Folders
            </span>
            <div className="space-y-0.5">
              {sortedFolders.map((f) =>
                renamingFolderId === f.recordId ? (
                  <div
                    key={f.recordId}
                    className="group flex w-full min-w-0 items-center gap-0.5 rounded-md bg-[color:var(--docs-el-accent)]/10 py-0.5 pl-0.5 dark:bg-[color:var(--docs-el-accent)]/15"
                  >
                    <span
                      className="flex h-9 w-10 shrink-0 items-center justify-center text-[color:var(--docs-el-muted)]"
                      aria-hidden
                    >
                      <Folder size={14} strokeWidth={1.8} />
                    </span>
                    <SidebarFolderRenameField
                      folderId={f.recordId}
                      renameFolderValue={renameFolderValue}
                      setRenameFolderValue={setRenameFolderValue}
                      onCommitFolderRenameRef={onCommitFolderRenameRef}
                      onCancelRenameFolder={onCancelRenameFolder}
                      blurTimerRef={folderRenameBlurTimerRef}
                      sessionStartRef={folderRenameSessionStartRef}
                      testId={`rename-folder-input-${f.recordId}`}
                    />
                  </div>
                ) : (
                  <NavRow
                    key={f.recordId}
                    active={selection.kind === 'folder' && selection.folderId === f.recordId}
                    icon={Folder}
                    label={f.data.name}
                    testId={`library-nav-folder-${f.recordId}`}
                    onClick={() => onSelect({ kind: 'folder', folderId: f.recordId })}
                    collapsed={collapsed}
                    trailing={
                      <span className="relative z-[1] flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          data-testid={`rename-folder-${f.recordId}`}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            onStartRenameFolder(f)
                          }}
                          className="rounded p-1 text-[color:var(--docs-el-muted)] opacity-0 transition-all hover:bg-black/[0.04] hover:text-[color:var(--docs-el-accent)] group-hover:opacity-100 dark:hover:bg-white/[0.06]"
                          title="Rename folder"
                          aria-label={`Rename folder ${f.data.name}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`delete-folder-${f.recordId}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (
                              confirm(
                                `Delete folder “${f.data.name}”? Documents inside will move to uncategorized.`,
                              )
                            ) {
                              void onDeleteFolder(f.recordId)
                            }
                          }}
                          className="rounded p-1 text-[color:var(--docs-el-muted)] opacity-0 transition-all hover:bg-red-500/10 hover:text-red-600 group-hover:opacity-100"
                          title="Delete folder"
                          aria-label={`Delete folder ${f.data.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    }
                  />
                ),
              )}

              {addingFolder ? (
                <div className="py-1">
                  <input
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onBlur={() => void submitNewFolder()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitNewFolder()
                      if (e.key === 'Escape') {
                        setAddingFolder(false)
                        setNewFolderName('')
                      }
                    }}
                    placeholder="Folder name"
                    data-testid="new-folder-input"
                    className="w-full rounded-md border px-2 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    style={{
                      borderColor: 'var(--docs-el-line)',
                      backgroundColor: 'var(--docs-el-bg)',
                      color: 'var(--docs-el-text)',
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  data-testid="new-folder-btn"
                  onClick={() => {
                    if (!collapsed) {
                      setAddingFolder(true)
                      return
                    }
                    const name = window.prompt('Folder name')?.trim()
                    if (name) void onCreateFolder(name)
                  }}
                  title={collapsed ? 'New folder' : undefined}
                  className="flex h-9 w-full min-w-0 items-center gap-0 rounded-md pl-0.5 pr-0 text-left text-[13px] text-[color:var(--docs-el-muted)] transition-colors hover:bg-black/[0.04] hover:text-[color:var(--docs-el-accent)] dark:hover:bg-white/[0.06]"
                >
                  <span className="flex h-9 w-10 shrink-0 items-center justify-center" aria-hidden>
                    <FolderPlus className="h-3.5 w-3.5 shrink-0" />
                  </span>
                  <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate pr-2'}>
                    New folder
                  </span>
                </button>
              )}
            </div>
          </div>
        </nav>
      </div>
    </aside>
  )
}
