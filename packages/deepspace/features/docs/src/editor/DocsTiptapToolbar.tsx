/**
 * Editor toolbar — issues Tiptap chain commands (no execCommand).
 *
 * Active state is read from the live editor via `useEditorState`, so toggles
 * accurately reflect the current selection without manually re-rendering.
 */

import { useState, type ReactNode } from 'react'
import { type Editor, useEditorState } from '@tiptap/react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Indent,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Outdent,
  Palette,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react'

const ZOOM_PRESETS = [
  { label: '75%', value: 0.75 },
  { label: '100%', value: 1 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
]

const TEXT_COLOR_OPTIONS = [
  { label: 'Default', value: '' },
  { label: 'Gray', value: '#6b7280' },
  { label: 'Red', value: '#dc2626' },
  { label: 'Orange', value: '#ea580c' },
  { label: 'Yellow', value: '#ca8a04' },
  { label: 'Green', value: '#16a34a' },
  { label: 'Blue', value: '#2563eb' },
  { label: 'Purple', value: '#7c3aed' },
]

const HIGHLIGHT_OPTIONS = [
  { label: 'None', value: '' },
  { label: 'Blue', value: '#bfdbfe' },
  { label: 'Yellow', value: '#fde68a' },
  { label: 'Green', value: '#bbf7d0' },
  { label: 'Pink', value: '#fbcfe8' },
]

function Divider() {
  return (
    <div className="mx-1 h-6 w-px self-center" style={{ backgroundColor: 'var(--docs-el-line)' }} />
  )
}

function ToolbarButton({
  onClick,
  disabled,
  active,
  title,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  active?: boolean
  title: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded p-1.5 transition-colors ${
        disabled
          ? 'cursor-not-allowed opacity-40'
          : 'hover:bg-black/[0.06] dark:hover:bg-white/[0.08]'
      }`}
      style={{
        color: active ? 'var(--docs-el-accent)' : 'var(--docs-el-muted)',
        backgroundColor: active
          ? 'color-mix(in srgb, var(--docs-el-accent) 14%, transparent)'
          : undefined,
      }}
    >
      {children}
    </button>
  )
}

export interface DocsTiptapToolbarProps {
  editor: Editor | null
  disabled?: boolean
  canvasZoom: number
  onCanvasZoomChange: (z: number) => void
}

const EMPTY_TOOLBAR_STATE = {
  canUndo: false,
  canRedo: false,
  isBold: false,
  isItalic: false,
  isUnderline: false,
  isStrike: false,
  isH1: false,
  isH2: false,
  isH3: false,
  isBlockquote: false,
  isBulletList: false,
  isOrderedList: false,
  alignLeft: false,
  alignCenter: false,
  alignRight: false,
}

export function DocsTiptapToolbar({
  editor,
  disabled,
  canvasZoom,
  onCanvasZoomChange,
}: DocsTiptapToolbarProps) {
  const [zoomOpen, setZoomOpen] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)
  const [highlightOpen, setHighlightOpen] = useState(false)
  const iconSize = 'h-4 w-4'

  /**
   * Read live editor state so toggles reflect the actual selection. Falls
   * back to no-op flags when `editor` is null (initial render before the
   * Tiptap instance is ready) or when the underlying ProseMirror view has
   * been torn down — that happens transiently during StrictMode double-mount
   * in dev and when `docId` changes (which swaps the Y.Doc and forces the
   * editor to be re-created). Calling `e.can()` on a destroyed editor throws
   * "Cannot read properties of null (reading 'can')" inside Tiptap.
   */
  const state =
    useEditorState({
      editor,
      selector: ({ editor: e }) => {
        if (!e || e.isDestroyed || !e.view) {
          return EMPTY_TOOLBAR_STATE
        }
        try {
          return {
            canUndo: e.can().chain().undo().run(),
            canRedo: e.can().chain().redo().run(),
            isBold: e.isActive('bold'),
            isItalic: e.isActive('italic'),
            isUnderline: e.isActive('underline'),
            isStrike: e.isActive('strike'),
            isH1: e.isActive('heading', { level: 1 }),
            isH2: e.isActive('heading', { level: 2 }),
            isH3: e.isActive('heading', { level: 3 }),
            isBlockquote: e.isActive('blockquote'),
            isBulletList: e.isActive('bulletList'),
            isOrderedList: e.isActive('orderedList'),
            alignLeft: e.isActive({ textAlign: 'left' }),
            alignCenter: e.isActive({ textAlign: 'center' }),
            alignRight: e.isActive({ textAlign: 'right' }),
          }
        } catch {
          return EMPTY_TOOLBAR_STATE
        }
      },
    }) ?? EMPTY_TOOLBAR_STATE

  /** Formatting actions require a mounted editor and an enabled connection/role. */
  const formattingLocked = disabled || !editor

  const run = (fn: (chain: ReturnType<Editor['chain']>) => unknown) => {
    if (!editor || disabled) return
    fn(editor.chain().focus())
  }

  const normalizedZoom =
    ZOOM_PRESETS.find((p) => Math.abs(p.value - canvasZoom) < 0.001)?.label ??
    `${Math.round(canvasZoom * 100)}%`

  return (
    <div
      data-testid="editor-toolbar"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b px-3 py-1.5 print:hidden"
      style={{
        borderColor: 'var(--docs-el-line)',
        backgroundColor: 'color-mix(in srgb, var(--docs-el-surface) 96%, transparent)',
      }}
    >
      <ToolbarButton
        onClick={() => run((c) => c.undo().run())}
        disabled={formattingLocked || !state.canUndo}
        title="Undo (⌘Z)"
      >
        <Undo2 className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.redo().run())}
        disabled={formattingLocked || !state.canRedo}
        title="Redo (⌘⇧Z)"
      >
        <Redo2 className={iconSize} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => run((c) => c.toggleHeading({ level: 1 }).run())}
        disabled={formattingLocked}
        active={state.isH1}
        title="Heading 1"
      >
        <Heading1 className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.toggleHeading({ level: 2 }).run())}
        disabled={formattingLocked}
        active={state.isH2}
        title="Heading 2"
      >
        <Heading2 className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.toggleHeading({ level: 3 }).run())}
        disabled={formattingLocked}
        active={state.isH3}
        title="Heading 3"
      >
        <Heading3 className={iconSize} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => run((c) => c.toggleBold().run())}
        disabled={formattingLocked}
        active={state.isBold}
        title="Bold (⌘B)"
      >
        <Bold className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.toggleItalic().run())}
        disabled={formattingLocked}
        active={state.isItalic}
        title="Italic (⌘I)"
      >
        <Italic className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.toggleUnderline().run())}
        disabled={formattingLocked}
        active={state.isUnderline}
        title="Underline (⌘U)"
      >
        <UnderlineIcon className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.toggleStrike().run())}
        disabled={formattingLocked}
        active={state.isStrike}
        title="Strikethrough"
      >
        <Strikethrough className={iconSize} />
      </ToolbarButton>

      <Divider />

      <div className="relative">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setColorOpen((o) => !o)
            setHighlightOpen(false)
            setZoomOpen(false)
          }}
          disabled={formattingLocked}
          className="flex items-center gap-1 rounded px-2 py-1 text-sm transition-colors hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/[0.06]"
          style={{ color: 'var(--docs-el-muted)' }}
          title="Text color"
        >
          <Palette className="h-3.5 w-3.5" />
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
            <path d="M3 5l3 3 3-3" />
          </svg>
        </button>
        {colorOpen && !formattingLocked ? (
          <>
            <button
              type="button"
              className="fixed inset-0 z-40 cursor-default bg-transparent"
              aria-label="Close color menu"
              onClick={() => setColorOpen(false)}
            />
            <div
              className="absolute left-0 top-full z-50 mt-1 grid w-[9.5rem] grid-cols-4 gap-1 rounded-lg border p-2 shadow-lg"
              style={{
                borderColor: 'var(--docs-el-line)',
                backgroundColor: 'var(--docs-el-surface)',
              }}
            >
              {TEXT_COLOR_OPTIONS.map(({ label, value }) => (
                <button
                  key={label}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (value) run((c) => c.setColor(value).run())
                    else run((c) => c.unsetColor().run())
                    setColorOpen(false)
                  }}
                  title={label}
                  aria-label={label}
                  className="h-7 w-7 rounded-full border transition-transform hover:scale-105"
                  style={{
                    backgroundColor: value || 'transparent',
                    borderColor: 'var(--docs-el-line)',
                  }}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="relative">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setHighlightOpen((o) => !o)
            setColorOpen(false)
            setZoomOpen(false)
          }}
          disabled={formattingLocked}
          className="flex items-center gap-1 rounded px-2 py-1 text-sm transition-colors hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/[0.06]"
          style={{ color: 'var(--docs-el-muted)' }}
          title="Highlight"
        >
          <Highlighter className="h-3.5 w-3.5" />
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
            <path d="M3 5l3 3 3-3" />
          </svg>
        </button>
        {highlightOpen && !formattingLocked ? (
          <>
            <button
              type="button"
              className="fixed inset-0 z-40 cursor-default bg-transparent"
              aria-label="Close highlight menu"
              onClick={() => setHighlightOpen(false)}
            />
            <div
              className="absolute left-0 top-full z-50 mt-1 grid w-[9.5rem] grid-cols-4 gap-1 rounded-lg border p-2 shadow-lg"
              style={{
                borderColor: 'var(--docs-el-line)',
                backgroundColor: 'var(--docs-el-surface)',
              }}
            >
              {HIGHLIGHT_OPTIONS.map(({ label, value }) => (
                <button
                  key={label}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (value) run((c) => c.toggleHighlight({ color: value }).run())
                    else run((c) => c.unsetHighlight().run())
                    setHighlightOpen(false)
                  }}
                  title={label}
                  aria-label={label}
                  className="h-7 w-7 rounded-full border transition-transform hover:scale-105"
                  style={{
                    backgroundColor: value || 'transparent',
                    borderColor: 'var(--docs-el-line)',
                  }}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>

      <Divider />

      <ToolbarButton
        onClick={() => run((c) => c.toggleBlockquote().run())}
        disabled={formattingLocked}
        active={state.isBlockquote}
        title="Block quote"
      >
        <Quote className={iconSize} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => run((c) => c.setTextAlign('left').run())}
        disabled={formattingLocked}
        active={state.alignLeft}
        title="Align left"
      >
        <AlignLeft className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.setTextAlign('center').run())}
        disabled={formattingLocked}
        active={state.alignCenter}
        title="Align center"
      >
        <AlignCenter className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.setTextAlign('right').run())}
        disabled={formattingLocked}
        active={state.alignRight}
        title="Align right"
      >
        <AlignRight className={iconSize} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => run((c) => c.toggleBulletList().run())}
        disabled={formattingLocked}
        active={state.isBulletList}
        title="Bulleted list"
      >
        <List className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.toggleOrderedList().run())}
        disabled={formattingLocked}
        active={state.isOrderedList}
        title="Numbered list"
      >
        <ListOrdered className={iconSize} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => {
          if (formattingLocked || !editor) return
          const previousUrl = editor.getAttributes('link').href as string | undefined
          const url = window.prompt('Link URL', previousUrl ?? '')
          if (url === null) return
          if (url === '') {
            run((c) => c.extendMarkRange('link').unsetLink().run())
            return
          }
          run((c) => c.extendMarkRange('link').setLink({ href: url }).run())
        }}
        disabled={formattingLocked}
        title="Link"
      >
        <LinkIcon className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.setHorizontalRule().run())}
        disabled={formattingLocked}
        title="Horizontal rule"
      >
        <Minus className={iconSize} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => run((c) => c.sinkListItem('listItem').run())}
        disabled={formattingLocked}
        title="Indent list item"
      >
        <Indent className={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => run((c) => c.liftListItem('listItem').run())}
        disabled={formattingLocked}
        title="Outdent list item"
      >
        <Outdent className={iconSize} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => run((c) => c.unsetAllMarks().clearNodes().run())}
        disabled={formattingLocked}
        title="Clear formatting"
      >
        <RemoveFormatting className={iconSize} />
      </ToolbarButton>

      <div className="ml-auto relative">
        <button
          type="button"
          onClick={() => setZoomOpen(!zoomOpen)}
          className="flex min-w-[3.25rem] items-center gap-1 rounded px-2 py-1 text-sm tabular-nums transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
          style={{ color: 'var(--docs-el-muted)' }}
        >
          {normalizedZoom}
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
            <path d="M3 5l3 3 3-3" />
          </svg>
        </button>
        {zoomOpen && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-40 cursor-default bg-transparent"
              aria-label="Close"
              onClick={() => setZoomOpen(false)}
            />
            <div
              className="absolute right-0 top-full z-50 mt-1 min-w-[7rem] overflow-y-auto rounded-lg border py-1 shadow-lg"
              style={{
                borderColor: 'var(--docs-el-line)',
                backgroundColor: 'var(--docs-el-surface)',
              }}
            >
              {ZOOM_PRESETS.map(({ label, value }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    onCanvasZoomChange(value)
                    setZoomOpen(false)
                  }}
                  className="w-full px-3 py-1.5 text-left text-sm tabular-nums transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  style={{
                    color:
                      Math.abs(canvasZoom - value) < 0.001
                        ? 'var(--docs-el-accent)'
                        : 'var(--docs-el-text)',
                    fontWeight: Math.abs(canvasZoom - value) < 0.001 ? 600 : 400,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
