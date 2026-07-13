/**
 * CanvasListPage — List of canvas documents.
 *
 * Shows all canvas documents (stored in RecordRoom) with
 * create and delete functionality.
 *
 * Navigates to /canvas/:docId when a canvas is selected.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUser } from 'deepspace'
import { useQuery } from 'deepspace'
import { useMutations } from 'deepspace'
import { Button, Modal, EmptyState } from '@/components/ui'
import { ROLES, type Role } from 'deepspace'

// ============================================================================
// Types
// ============================================================================

interface CanvasDocument {
  title: string
  ownerId: string
}

// ============================================================================
// Create Canvas Modal
// ============================================================================

interface CreateCanvasModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (title: string) => void
}

function CreateCanvasModal({ isOpen, onClose, onCreate }: CreateCanvasModalProps) {
  const [title, setTitle] = useState('')

  const handleSubmit = () => {
    if (title.trim()) {
      onCreate(title.trim())
      setTitle('')
      onClose()
    }
  }

  return (
    <Modal open={isOpen} onClose={onClose} size="sm">
      <Modal.Header onClose={onClose}>
        <Modal.Title>New Canvas</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">Title</label>
          <input
            data-testid="canvas-title-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Wireframe Draft"
            className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button data-testid="canvas-create-submit" onClick={handleSubmit} disabled={!title.trim()}>Create</Button>
      </Modal.Footer>
    </Modal>
  )
}

// ============================================================================
// Main Page
// ============================================================================

export default function CanvasListPage() {
  const { user } = useUser()
  const navigate = useNavigate()
  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const canCreate = userRole === ROLES.MEMBER || userRole === ROLES.ADMIN

  const [showCreateModal, setShowCreateModal] = useState(false)

  const { records: canvases, status } = useQuery<CanvasDocument>('canvases', {
    orderBy: 'createdAt',
    orderDir: 'desc',
  })
  const { create, remove } = useMutations<CanvasDocument>('canvases')

  const handleCreate = async (title: string) => {
    await create({ title, ownerId: user!.id })
  }

  const handleDelete = async (canvasId: string) => {
    if (confirm('Delete this canvas?')) {
      await remove(canvasId)
    }
  }

  const isLoading = status === 'loading'

  return (
    <div data-testid="canvas-page" className="h-full bg-background overflow-y-auto">
      {/* Header */}
      <div className="bg-card/60 backdrop-blur-md border-b border-border sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Canvas</h1>
              <p className="text-muted-foreground mt-1">Collaborative spatial editing</p>
            </div>
            {canCreate && (
              <Button data-testid="canvas-create-btn" onClick={() => setShowCreateModal(true)}>
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New Canvas
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Canvas list */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          </div>
        ) : canvases.length === 0 ? (
          <EmptyState
            title="No canvases yet"
            description={canCreate ? 'Create your first canvas to start collaborating' : 'No canvases have been created yet'}
            icon={
              <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {canvases.map((canvas) => {
              const isOwner = canvas.data.ownerId === user?.id
              return (
                <div
                  key={canvas.recordId}
                  data-testid={`canvas-card-${canvas.recordId}`}
                  className="group p-4 bg-card/60 rounded-xl border border-border hover:border-primary/30 hover:bg-muted/40 transition-all cursor-pointer"
                  onClick={() => navigate(`/canvas/${canvas.recordId}`)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <svg className="w-4 h-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <h3 className="font-medium text-foreground truncate">{canvas.data.title}</h3>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {new Date(canvas.createdAt).toLocaleDateString()}
                        {isOwner && ' · You'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isOwner && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete(canvas.recordId)
                          }}
                          className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/20 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                          title="Delete"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                      <svg className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <CreateCanvasModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreate}
      />
    </div>
  )
}
