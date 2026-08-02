/**
 * Items Page
 *
 * Demonstrates:
 * - useQuery for fetching records
 * - useMutations for CRUD operations
 * - useUser for current user
 * - Role-based UI elements
 */

import { useMemo, useState } from 'react'
import { Archive, ArchiveRestore, Inbox, Plus, Trash2 } from 'lucide-react'
import { ROLES, useMutations, useQuery, useUser, type Role } from 'deepspace'
import {
  Badge,
  Button,
  ConfirmModal,
  EmptyState,
  Input,
  Label,
  Modal,
  Textarea,
  useToast,
} from '@/components/ui'

const ITEM_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const

interface Item {
  title: string
  description?: string
  status: string
  ownerId: string
}

type ItemRecord = {
  recordId: string
  data: Item
  createdAt: string
}

interface ItemsPageProps {
  className?: string
}

interface CreateItemModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (title: string, description: string) => Promise<boolean>
}

function CreateItemModal({ isOpen, onClose, onCreate }: CreateItemModalProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)

  const handleSubmit = async () => {
    const nextTitle = title.trim()
    if (!nextTitle || creating) return

    setCreating(true)
    try {
      const created = await onCreate(nextTitle, description.trim())
      if (!created) return
      setTitle('')
      setDescription('')
      onClose()
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal open={isOpen} onClose={creating ? () => undefined : onClose} size="sm">
      <Modal.Header>
        <Modal.Title>Create Item</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          <div>
            <Label htmlFor="item-title" className="mb-2 block">
              Title
            </Label>
            <Input
              id="item-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Enter item title"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="item-description" className="mb-2 block">
              Description
            </Label>
            <Textarea
              id="item-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Enter description (optional)"
              rows={3}
              className="resize-none"
            />
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Button onClick={() => void handleSubmit()} disabled={!title.trim()} loading={creating}>
          Create
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

interface ItemCardProps {
  item: ItemRecord
  isOwner: boolean
  isToggling?: boolean
  onToggleStatus: () => void
  onDelete: () => void
}

function ItemCard({ item, isOwner, isToggling = false, onToggleStatus, onDelete }: ItemCardProps) {
  const isArchived = item.data.status === ITEM_STATUS.ARCHIVED
  const statusAction = isArchived ? 'Restore' : 'Archive'

  return (
    <div
      className={`rounded-xl border bg-card/60 p-4 ${
        isArchived ? 'border-border/30 opacity-60' : 'border-border'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <h3
              className={`font-medium ${
                isArchived ? 'text-muted-foreground line-through' : 'text-foreground'
              }`}
            >
              {item.data.title}
            </h3>
            <Badge variant={isArchived ? 'secondary' : 'success'} size="sm">
              {isArchived ? 'Archived' : 'Active'}
            </Badge>
          </div>
          {item.data.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{item.data.description}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {new Date(item.createdAt).toLocaleDateString()}
          </p>
        </div>

        {isOwner && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              onClick={onToggleStatus}
              aria-label={`${statusAction} ${item.data.title}`}
              loading={isToggling}
            >
              {!isToggling &&
                (isArchived ? (
                  <ArchiveRestore aria-hidden="true" />
                ) : (
                  <Archive aria-hidden="true" />
                ))}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
              onClick={onDelete}
              disabled={isToggling}
              aria-label={`Delete ${item.data.title}`}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ItemsPage({ className }: ItemsPageProps) {
  const { user } = useUser()
  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const canCreate = userRole === ROLES.MEMBER || userRole === ROLES.ADMIN
  const toast = useToast()

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ItemRecord | null>(null)
  const [deleting, setDeleting] = useState(false)

  const { records: items, status } = useQuery<Item>('items', {
    orderBy: 'createdAt',
    orderDir: 'desc',
  })
  const { createConfirmed, putConfirmed, removeConfirmed } = useMutations<Item>('items')

  const { myItems, otherItems } = useMemo(() => {
    const my: typeof items = []
    const other: typeof items = []

    items.forEach((item) => {
      if (item.data.ownerId === user?.id) my.push(item)
      else other.push(item)
    })

    return { myItems: my, otherItems: other }
  }, [items, user?.id])

  const handleCreate = async (title: string, description: string): Promise<boolean> => {
    if (!user) {
      toast.error('Could not create item', 'Sign in and try again.')
      return false
    }

    try {
      await createConfirmed({
        title,
        description,
        status: ITEM_STATUS.ACTIVE,
        ownerId: user.id,
      })
      toast.success('Item created', `"${title}" is ready.`)
      return true
    } catch (error) {
      toast.error(
        'Could not create item',
        error instanceof Error ? error.message : 'Please try again.',
      )
      return false
    }
  }

  const handleToggleStatus = async (itemId: string, currentStatus: string) => {
    const item = items.find((candidate) => candidate.recordId === itemId)
    if (!item || togglingId) return

    const newStatus =
      currentStatus === ITEM_STATUS.ACTIVE ? ITEM_STATUS.ARCHIVED : ITEM_STATUS.ACTIVE
    setTogglingId(itemId)
    try {
      await putConfirmed(itemId, { status: newStatus })
      if (newStatus === ITEM_STATUS.ARCHIVED) {
        toast.success('Item archived', `"${item.data.title}" moved to the archive.`)
      } else {
        toast.success('Item restored', `"${item.data.title}" is active again.`)
      }
    } catch (error) {
      toast.error(
        'Could not update item',
        error instanceof Error ? error.message : 'Please try again.',
      )
    } finally {
      setTogglingId(null)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return

    setDeleting(true)
    try {
      await removeConfirmed(deleteTarget.recordId)
      toast.success('Item deleted', `"${deleteTarget.data.title}" was deleted.`)
      setDeleteTarget(null)
    } catch (error) {
      toast.error(
        'Could not delete item',
        error instanceof Error ? error.message : 'Please try again.',
      )
    } finally {
      setDeleting(false)
    }
  }

  const isLoading = status === 'loading'

  return (
    <div className={`h-full overflow-y-auto bg-background ${className ?? ''}`}>
      <div className="sticky top-0 z-10 border-b border-border bg-card/60 backdrop-blur-md">
        <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Items</h1>
              <p className="mt-1 text-muted-foreground">
                {isLoading
                  ? 'Loading items...'
                  : `${items.length} ${items.length === 1 ? 'item' : 'items'} in this workspace`}
              </p>
            </div>

            {canCreate && (
              <Button onClick={() => setShowCreateModal(true)}>
                <Plus aria-hidden="true" />
                New Item
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2" aria-label="Loading items" aria-busy="true">
            <div className="h-32 animate-pulse rounded-xl border border-border bg-muted/40" />
            <div className="h-32 animate-pulse rounded-xl border border-border bg-muted/40" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="No items yet"
            description={
              canCreate
                ? 'Create your first item to get started.'
                : 'No items have been created yet.'
            }
            icon={<Inbox aria-hidden="true" />}
            action={
              canCreate ? { label: 'New item', onClick: () => setShowCreateModal(true) } : undefined
            }
          />
        ) : (
          <div className="space-y-8">
            {myItems.length > 0 && (
              <section>
                <h2 className="mb-4 text-lg font-semibold text-foreground">My Items</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {myItems.map((item) => (
                    <ItemCard
                      key={item.recordId}
                      item={item}
                      isOwner
                      isToggling={togglingId === item.recordId}
                      onToggleStatus={() =>
                        void handleToggleStatus(item.recordId, item.data.status)
                      }
                      onDelete={() => setDeleteTarget(item)}
                    />
                  ))}
                </div>
              </section>
            )}

            {otherItems.length > 0 && (
              <section>
                <h2 className="mb-4 text-lg font-semibold text-foreground">All Items</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {otherItems.map((item) => (
                    <ItemCard
                      key={item.recordId}
                      item={item}
                      isOwner={false}
                      onToggleStatus={() => undefined}
                      onDelete={() => undefined}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      <CreateItemModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreate}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null)
        }}
        onConfirm={() => void handleDelete()}
        title={deleteTarget ? `Delete "${deleteTarget.data.title}"?` : 'Delete item?'}
        description="This cannot be undone."
        confirmText="Delete"
        loading={deleting}
      />
    </div>
  )
}
