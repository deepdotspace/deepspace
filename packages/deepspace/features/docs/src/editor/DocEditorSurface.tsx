/**
 * Paged editor surface — Letter-sized, decoration-based pagination.
 *
 * The ProseMirror document stays as one collaborative document. Pagination is
 * a view-only layer: we measure rendered text, insert ProseMirror Decoration
 * widgets at the calculated page boundaries (spacer divs filling the rest of
 * each sheet), and render absolutely-positioned "page face" backgrounds
 * behind the content. The Yjs document is never touched.
 *
 * Decorations are a no-op for the CRDT, so adding/removing page breaks
 * never produces a Yjs update, never re-syncs, and never moves a remote
 * collaborator's caret.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { EditorContent, type Editor } from '@tiptap/react'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const PX_PER_IN = 96
const PAGE_W_IN = 8.5
const PAGE_H_IN = 11
export const PAGE_HEIGHT_PX = Math.round(PAGE_H_IN * PX_PER_IN)
export const PAGE_WIDTH_PX = Math.round(PAGE_W_IN * PX_PER_IN)
export const GAP_PX = 24
const PAGE_STRIDE_PX = PAGE_HEIGHT_PX + GAP_PX
const PAGE_EPSILON_PX = 3
const MAX_SOFT_PAGE_BREAKS = 80
const PAGINATION_UPDATE_DELAY_MS = 180

export const TYPICAL_WORDS_PER_PAGE = 480

type SoftPageBreak = {
  pos: number
  height: number
}

function pageCountForBodyHeight(bodyHeight: number, pageBodyHeight: number) {
  let pages = 1
  while (bodyHeight > (pages - 1) * PAGE_STRIDE_PX + pageBodyHeight + PAGE_EPSILON_PX) {
    pages += 1
  }
  return pages
}

function makeSoftPageBreakDecorations(editor: Editor, breaks: SoftPageBreak[]) {
  if (breaks.length === 0) return DecorationSet.empty

  const docSize = editor.state.doc.content.size
  return DecorationSet.create(
    editor.state.doc,
    breaks.map((pageBreak, index) =>
      Decoration.widget(
        Math.min(pageBreak.pos, docSize),
        () => {
          const spacer = document.createElement('span')
          spacer.className = 'docs-soft-page-break'
          spacer.style.height = `${pageBreak.height}px`
          spacer.contentEditable = 'false'
          spacer.setAttribute('aria-hidden', 'true')
          return spacer
        },
        {
          key: `docs-page-break-${index}-${pageBreak.pos}-${Math.round(pageBreak.height)}`,
          side: 1,
          ignoreSelection: true,
        },
      ),
    ),
  )
}

type DocEditorSurfaceProps = {
  editor: Editor
  onPageCountChange?: (n: number) => void
}

export function DocEditorSurface({ editor, onPageCountChange }: DocEditorSurfaceProps) {
  const [pageCount, setPageCount] = useState(1)
  const pageBreaksRef = useRef<SoftPageBreak[]>([])
  const rafRef = useRef<number | undefined>(undefined)
  const recalcTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const report = useCallback(
    (n: number) => {
      onPageCountChange?.(n)
      setPageCount((prev) => (prev === n ? prev : n))
    },
    [onPageCountChange],
  )

  useLayoutEffect(() => {
    const view = editor.view
    const dom = view?.dom
    if (!dom) return

    /**
     * `useEditor` destroys+recreates the Tiptap editor whenever the
     * `extensions` array identity changes — notably when the owner toggles
     * this peer between editor and viewer, since the placeholder string
     * flips on `showReadOnlyDocUx`. The destroy nulls the ProseMirror
     * `docView` internally; any rAF / timeout / ResizeObserver that fires
     * afterwards and still calls `view.dispatch` or `view.setProps` lands
     * in `updateStateInner` and throws
     * `Cannot read properties of null (reading 'matchesNode')`, killing
     * the route. `editor.isDestroyed` is the supported signal — set the
     * moment Tiptap tears the editor down — so we use it to short-circuit
     * every async callback rooted in this effect.
     */
    const viewIsAlive = () => !editor.isDestroyed

    const previousDecorations = view.props.decorations
    const refreshDecorations = () => {
      if (!viewIsAlive()) return
      view.dispatch(
        view.state.tr.setMeta('addToHistory', false).setMeta('docsPagination', true),
      )
    }

    view.setProps({
      decorations: (state) => {
        const externalDecorations =
          typeof previousDecorations === 'function'
            ? previousDecorations(state)
            : previousDecorations
        const pageDecorations = makeSoftPageBreakDecorations(editor, pageBreaksRef.current)

        if (!externalDecorations) return pageDecorations
        const externalDecorationItems: Decoration[] = []
        externalDecorations.forEachSet((set) => {
          externalDecorationItems.push(...set.find())
        })
        return DecorationSet.create(state.doc, [
          ...externalDecorationItems,
          ...pageDecorations.find(),
        ])
      },
    })

    const recalc = () => {
      if (recalcTimerRef.current !== undefined) {
        clearTimeout(recalcTimerRef.current)
        recalcTimerRef.current = undefined
      }
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = undefined
        if (!viewIsAlive()) return
        const shell = dom.closest<HTMLElement>('.docs-paged-content')
        if (!shell) return

        const shellStyle = window.getComputedStyle(shell)
        const paddingTop = Number.parseFloat(shellStyle.paddingTop) || 0
        const paddingBottom = Number.parseFloat(shellStyle.paddingBottom) || 0
        const pageBodyHeight = PAGE_HEIGHT_PX - paddingTop - paddingBottom

        pageBreaksRef.current = []
        refreshDecorations()

        let lastBreakPos = -1
        for (let pageIndex = 0; pageIndex < MAX_SOFT_PAGE_BREAKS; pageIndex += 1) {
          if (!viewIsAlive()) return
          const bodyHeight = dom.scrollHeight
          const pageBottom = pageIndex * PAGE_STRIDE_PX + pageBodyHeight
          if (bodyHeight <= pageBottom + PAGE_EPSILON_PX) break

          const domRect = dom.getBoundingClientRect()
          const posAtBoundary = view.posAtCoords({
            left: domRect.right - 2,
            top: domRect.top + pageBottom - 2,
          })

          if (!posAtBoundary || posAtBoundary.pos <= lastBreakPos) break

          const coords = view.coordsAtPos(posAtBoundary.pos)
          const breakY = Math.max(coords.bottom - domRect.top, pageIndex * PAGE_STRIDE_PX)
          const breakHeight = Math.max(0, (pageIndex + 1) * PAGE_STRIDE_PX - breakY)

          if (breakHeight <= PAGE_EPSILON_PX) break

          lastBreakPos = posAtBoundary.pos
          pageBreaksRef.current = [
            ...pageBreaksRef.current,
            { pos: posAtBoundary.pos, height: breakHeight },
          ]
          refreshDecorations()
        }

        if (!viewIsAlive()) return
        const pagedBodyHeight = dom.scrollHeight
        const measuredPages = pageCountForBodyHeight(pagedBodyHeight, pageBodyHeight)
        report(measuredPages)
      })
    }
    const scheduleRecalc = () => {
      if (recalcTimerRef.current !== undefined) clearTimeout(recalcTimerRef.current)
      recalcTimerRef.current = setTimeout(() => {
        recalcTimerRef.current = undefined
        if (!viewIsAlive()) return
        recalc()
      }, PAGINATION_UPDATE_DELAY_MS)
    }

    const ro = new ResizeObserver(() => {
      if (!viewIsAlive()) return
      recalc()
    })
    ro.observe(dom)
    recalc()
    editor.on('update', scheduleRecalc)

    return () => {
      if (recalcTimerRef.current !== undefined) clearTimeout(recalcTimerRef.current)
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
      recalcTimerRef.current = undefined
      rafRef.current = undefined
      ro.disconnect()
      editor.off('update', scheduleRecalc)
      pageBreaksRef.current = []
      if (!viewIsAlive()) return
      view.setProps({ decorations: previousDecorations })
      refreshDecorations()
    }
  }, [editor, report])

  const stackHeight = pageCount * PAGE_HEIGHT_PX + Math.max(0, pageCount - 1) * GAP_PX

  return (
    <div className="docs-paged-editor-canvas h-full min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain print:block print:!h-auto print:!overflow-visible print:!bg-white">
      <div className="docs-paged-inner pointer-events-auto mx-auto w-full max-w-full px-2 py-3 sm:px-3 sm:py-4 md:py-5">
        <div
          className="docs-paged-page-frame relative mx-auto"
          style={{ width: `${PAGE_W_IN}in`, maxWidth: '100%' }}
        >
          <div className="docs-paged-page-stack relative" style={{ minHeight: `${stackHeight}px` }}>
            {Array.from({ length: pageCount }, (_, index) => (
              <div
                key={index}
                className="docs-paged-page-face docs-editor-paper pointer-events-none absolute left-0 top-0 h-[11in] w-full rounded-sm print:static print:h-auto print:shadow-none print:border-0"
                style={{ transform: `translateY(${index * PAGE_STRIDE_PX}px)` }}
              />
            ))}
            <div
              className="docs-paged-content docs-paged-page-padding relative z-10 box-border"
              style={{ maxWidth: '100%', minHeight: `${stackHeight}px` }}
            >
              <EditorContent
                editor={editor}
                className="docs-paged-editor docs-paged-editor-font tiptap"
                data-testid="editor-content"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
