/**
 * CanvasEditorPage — Canvas editor for a single document.
 *
 * Gets docId from URL params and renders the CanvasView editor
 * connected to the CanvasRoom DO via useCanvas.
 *
 * Installed at: src/pages/canvas/[docId].tsx
 */

import { useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { CanvasView } from '../../components/canvas/CanvasView'

// ============================================================================
// Types
// ============================================================================

interface CanvasDocument {
  title: string
  ownerId: string
}

// ============================================================================
// Main Page
// ============================================================================

export default function CanvasEditorPage() {
  const { docId } = useParams<{ docId: string }>()
  const navigate = useNavigate()

  const { records: canvases, status } = useQuery<CanvasDocument>('canvases', {
    orderBy: 'createdAt',
    orderDir: 'desc',
  })

  const selectedCanvas = useMemo(
    () => docId ? canvases.find((c) => c.recordId === docId) : null,
    [canvases, docId],
  )

  const isLoading = status === 'loading'

  if (isLoading) {
    return (
      <div data-testid="canvas-page" className="h-full flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (!selectedCanvas) {
    return (
      <div data-testid="canvas-page" className="h-full flex flex-col items-center justify-center bg-background gap-4">
        <p className="text-muted-foreground">Canvas not found</p>
        <button
          onClick={() => navigate('/canvas')}
          className="text-primary hover:underline"
        >
          Back to canvas list
        </button>
      </div>
    )
  }

  return (
    <div data-testid="canvas-page" className="h-full flex flex-col bg-background">
      {/* Back header */}
      <div className="px-4 py-3 border-b border-border flex items-center gap-4 bg-card/60 backdrop-blur-md">
        <button
          data-testid="canvas-back"
          onClick={() => navigate('/canvas')}
          className="p-2 hover:bg-muted/60 rounded-lg transition-colors"
        >
          <svg className="w-5 h-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-lg font-semibold text-foreground">{selectedCanvas.data.title}</h2>
      </div>

      <CanvasView key={selectedCanvas.recordId} docId={selectedCanvas.recordId} className="flex-1" />
    </div>
  )
}
