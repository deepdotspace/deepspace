/**
 * Outline panel — renders a list of heading entries provided by the caller.
 *
 * In the Tiptap editor, headings are real ProseMirror nodes, so the page
 * walks `editor.state.doc` once on every doc update and passes the result
 * here. Clicking an entry jumps the caret to that node's position.
 */

/** Matches docs2 outline width + toggle positioning beside the panel */
export const DOCUMENT_OUTLINE_WIDTH_PX = 220

export interface OutlineEntry {
  level: number
  title: string
  /** ProseMirror position to focus when the entry is clicked. */
  pos: number
}

export interface DocsOutlinePanelProps {
  entries: OutlineEntry[]
  onJumpTo: (pos: number) => void
}

export function DocsOutlinePanel({ entries, onJumpTo }: DocsOutlinePanelProps) {
  return (
    <aside
      data-testid="document-outline-panel"
      className="absolute bottom-0 left-0 top-0 z-[34] flex flex-col overflow-hidden border-r print:hidden"
      style={{
        width: DOCUMENT_OUTLINE_WIDTH_PX,
        borderColor: 'var(--docs-el-line)',
        backgroundColor: 'color-mix(in srgb, var(--docs-el-surface) 95%, transparent)',
      }}
    >
      <div className="shrink-0 border-b px-3 py-3" style={{ borderColor: 'var(--docs-el-line)' }}>
        <h2 className="truncate pl-1 text-left text-sm font-normal leading-5 text-[color:var(--docs-el-muted)]">
          Document outline
        </h2>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {entries.length === 0 ? (
          <p className="px-2 py-4 text-[12px] leading-snug text-[color:var(--docs-el-muted)]">
            Headings you add to the document appear here. Use the H1 / H2 / H3 buttons in the
            toolbar.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {entries.map((e, i) => (
              <li key={`${e.pos}-${i}`}>
                <button
                  type="button"
                  onClick={() => onJumpTo(e.pos)}
                  className="w-full rounded-md px-2 py-1.5 text-left text-[12px] leading-snug transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                  style={{
                    paddingLeft: 8 + (e.level - 1) * 10,
                    color: 'var(--docs-el-text)',
                  }}
                >
                  {e.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  )
}
