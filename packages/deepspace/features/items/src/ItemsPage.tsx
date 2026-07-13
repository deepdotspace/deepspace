/**
 * Items Page
 *
 * Demonstrates:
 * - useQuery for fetching records
 * - useMutations for CRUD operations
 * - useUser for current user
 * - Role-based UI elements
 */

import { useState, useMemo } from 'react'
import { useUser } from 'deepspace'
import { useQuery } from 'deepspace'
import { useMutations } from 'deepspace'
import { Button, Modal, EmptyState, Badge } from '@/components/ui'
import { ROLES, type Role } from 'deepspace'
import { ITEM_STATUS } from '../components/items/items-constants'

// ============================================================================
// Types
// ============================================================================

interface Item {
  title: string
  description?: string
  status: string
  ownerId: string
}

interface ItemsPageProps {
  className?: string
}

// ============================================================================
// Create Item Modal
// ============================================================================

interface CreateItemModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (title: string, description: string) => void
}

function CreateItemModal({ isOpen, onClose, onCreate }: CreateItemModalProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  const handleSubmit = () => {
    if (title.trim()) {
      onCreate(title.trim(), description.trim())
      setTitle('')
      setDescription('')
      onClose()
    }
  }

  return (
    <Modal open={isOpen} onClose={onClose} size="sm">
      <Modal.Header onClose={onClose}>
        <Modal.Title>Create Item</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter item title"
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter description (optional)"
              rows={3}
              className="w-full px-3 py-2 bg-transparent border border-border rounded-lg text-foreground placeholder-muted-foreground focus:outline-none focus:ring-ring resize-none"
            />
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={!title.trim()}>Create</Button>
      </Modal.Footer>
    </Modal>
  )
}

// ============================================================================
// Item Card Component
// ============================================================================

interface ItemCardProps {
  item: { recordId: string; data: Item; createdAt: string }
  isOwner: boolean
  onToggleStatus: () => void
  onDelete: () => void
}

function ItemCard({ item, isOwner, onToggleStatus, onDelete }: ItemCardProps) {
  const isArchived = item.data.status === ITEM_STATUS.ARCHIVED

  return (
    <div className={`p-4 bg-card/60 rounded-xl border ${isArchived ? 'border-border/30 opacity-60' : 'border-border'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className={`font-medium ${isArchived ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
              {item.data.title}
            </h3>
            <Badge
              variant={isArchived ? 'secondary' : 'success'}
              size="sm"
            >
              {isArchived ? 'Archived' : 'Active'}
            </Badge>
          </div>
          {item.data.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">{item.data.description}</p>
          )}
          <p className="text-xs text-muted-foreground mt-2">
            {new Date(item.createdAt).toLocaleDateString()}
          </p>
        </div>

        {isOwner && (
          <div className="flex items-center gap-1">
            <button
              onClick={onToggleStatus}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-lg transition-colors"
              title={isArchived ? 'Restore' : 'Archive'}
            >
              {isArchived ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                </svg>
              )}
            </button>
            <button
              onClick={onDelete}
              className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/20 rounded-lg transition-colors"
              title="Delete"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Main Page
// ============================================================================

export default function ItemsPage({ className }: ItemsPageProps) {
  const { user } = useUser()
  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const canCreate = userRole === ROLES.MEMBER || userRole === ROLES.ADMIN

  const [showCreateModal, setShowCreateModal] = useState(false)

  // Query all items
  const { records: items, status } = useQuery<Item>('items', {
    orderBy: 'createdAt',
    orderDir: 'desc',
  })

  // Mutations for items
  const { create, put, remove } = useMutations<Item>('items')

  // Separate own items and others
  const { myItems, otherItems } = useMemo(() => {
    const my: typeof items = []
    const other: typeof items = []

    items.forEach(item => {
      if (item.data.ownerId === user?.id) {
        my.push(item)
      } else {
        other.push(item)
      }
    })

    return { myItems: my, otherItems: other }
  }, [items, user?.id])

  const handleCreate = async (title: string, description: string) => {
    await create({
      title,
      description,
      status: ITEM_STATUS.ACTIVE,
      ownerId: user!.id,
    })
  }

  const handleToggleStatus = async (itemId: string, currentStatus: string) => {
    const newStatus = currentStatus === ITEM_STATUS.ACTIVE
      ? ITEM_STATUS.ARCHIVED
      : ITEM_STATUS.ACTIVE

    const item = items.find(i => i.recordId === itemId)
    if (item) {
      await put(itemId, { ...item.data, status: newStatus })
    }
  }

  const handleDelete = async (itemId: string) => {
    if (confirm('Are you sure you want to delete this item?')) {
      await remove(itemId)
    }
  }

  const isLoading = status === 'loading'

  return (
    <div className={`h-full bg-background overflow-y-auto ${className ?? ''}`}>
      {/* Header */}
      <div className="bg-card/60 backdrop-blur-md border-b border-border sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Welcome, {user?.name ?? 'Guest'}</h1>
              <p className="text-muted-foreground mt-1">
                {canCreate
                  ? 'Create and manage your items below'
                  : 'You can view items but need member access to create'
                }
              </p>
            </div>

            {canCreate && (
              <Button onClick={() => setShowCreateModal(true)}>
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New Item
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="No items yet"
            description={canCreate
              ? "Create your first item to get started"
              : "No items have been created yet"
            }
            icon={
              <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
            }
          />
        ) : (
          <div className="space-y-8">
            {/* My Items */}
            {myItems.length > 0 && (
              <section>
                <h2 className="text-lg font-semibold text-foreground mb-4">My Items</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {myItems.map(item => (
                    <ItemCard
                      key={item.recordId}
                      item={item}
                      isOwner={true}
                      onToggleStatus={() => handleToggleStatus(item.recordId, item.data.status)}
                      onDelete={() => handleDelete(item.recordId)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Other Items */}
            {otherItems.length > 0 && (
              <section>
                <h2 className="text-lg font-semibold text-foreground mb-4">All Items</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {otherItems.map(item => (
                    <ItemCard
                      key={item.recordId}
                      item={item}
                      isOwner={false}
                      onToggleStatus={() => {}}
                      onDelete={() => {}}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <CreateItemModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreate}
      />
    </div>
  )
}
