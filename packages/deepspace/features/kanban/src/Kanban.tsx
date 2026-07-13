import React, { useState, useCallback, ReactNode, DragEvent } from 'react'
import { MoreHorizontal, Plus, GripVertical } from 'lucide-react'

// ============================================================================
// Types
// ============================================================================

export interface KanbanItem {
  id: string
  title: string
  description?: string
  columnId: string
  [key: string]: unknown
}

export interface KanbanColumn {
  id: string
  title: string
  color?: string
}

// ============================================================================
// KanbanBoard - Main container
// ============================================================================

interface KanbanBoardProps<T extends KanbanItem> {
  columns: KanbanColumn[]
  items: T[]
  onMoveItem: (itemId: string, toColumnId: string) => void
  onAddItem?: (columnId: string) => void
  renderItem?: (item: T) => ReactNode
  className?: string
}

export function KanbanBoard<T extends KanbanItem>({
  columns,
  items,
  onMoveItem,
  onAddItem,
  renderItem,
  className = '',
}: KanbanBoardProps<T>) {
  const [draggedItem, setDraggedItem] = useState<string | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null)

  const handleDragStart = useCallback((itemId: string) => {
    setDraggedItem(itemId)
  }, [])

  const handleDragEnd = useCallback(() => {
    setDraggedItem(null)
    setDragOverColumn(null)
  }, [])

  const handleDragOver = useCallback((e: DragEvent, columnId: string) => {
    e.preventDefault()
    setDragOverColumn(columnId)
  }, [])

  const handleDrop = useCallback((e: DragEvent, columnId: string) => {
    e.preventDefault()
    if (draggedItem) {
      onMoveItem(draggedItem, columnId)
    }
    setDraggedItem(null)
    setDragOverColumn(null)
  }, [draggedItem, onMoveItem])

  return (
    <div className={`flex gap-4 overflow-x-auto pb-4 ${className}`}>
      {columns.map((column) => {
        const columnItems = items.filter((item) => item.columnId === column.id)
        const isDragOver = dragOverColumn === column.id

        return (
          <KanbanColumnComponent
            key={column.id}
            column={column}
            items={columnItems}
            isDragOver={isDragOver}
            onDragOver={(e) => handleDragOver(e, column.id)}
            onDrop={(e) => handleDrop(e, column.id)}
            onDragLeave={() => setDragOverColumn(null)}
            onAddItem={onAddItem ? () => onAddItem(column.id) : undefined}
          >
            {columnItems.map((item) => (
              <KanbanCard
                key={item.id}
                item={item}
                isDragging={draggedItem === item.id}
                onDragStart={() => handleDragStart(item.id)}
                onDragEnd={handleDragEnd}
                renderContent={renderItem}
              />
            ))}
          </KanbanColumnComponent>
        )
      })}
    </div>
  )
}

// ============================================================================
// KanbanColumn
// ============================================================================

interface KanbanColumnComponentProps<T extends KanbanItem> {
  column: KanbanColumn
  items: T[]
  children: ReactNode
  isDragOver: boolean
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onDragLeave: () => void
  onAddItem?: () => void
}

function KanbanColumnComponent<T extends KanbanItem>({
  column,
  items,
  children,
  isDragOver,
  onDragOver,
  onDrop,
  onDragLeave,
  onAddItem,
}: KanbanColumnComponentProps<T>) {
  return (
    <div
      className={`
        flex flex-col w-72 min-w-72 bg-muted/50 rounded-lg
        transition-colors duration-200
        ${isDragOver ? 'bg-primary/10 ring-2 ring-primary/20' : ''}
      `}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeave}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          {column.color && (
            <span
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: column.color }}
            />
          )}
          <h3 className="font-medium text-foreground">{column.title}</h3>
          <span className="px-2 py-0.5 text-xs bg-muted rounded-full text-muted-foreground">
            {items.length}
          </span>
        </div>
        <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>

      {/* Items */}
      <div className="flex-1 p-2 space-y-2 min-h-[200px] overflow-y-auto">
        {children}
      </div>

      {/* Add button */}
      {onAddItem && (
        <button
          onClick={onAddItem}
          className="flex items-center gap-2 p-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add item
        </button>
      )}
    </div>
  )
}

// ============================================================================
// KanbanCard
// ============================================================================

interface KanbanCardProps<T extends KanbanItem> {
  item: T
  isDragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  renderContent?: (item: T) => ReactNode
}

function KanbanCard<T extends KanbanItem>({
  item,
  isDragging,
  onDragStart,
  onDragEnd,
  renderContent,
}: KanbanCardProps<T>) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`
        group bg-card border border-border rounded-lg p-3 cursor-grab
        hover:border-border/80 hover:shadow-sm transition-all
        ${isDragging ? 'opacity-50 rotate-2 shadow-lg' : ''}
      `}
    >
      {renderContent ? (
        renderContent(item)
      ) : (
        <>
          <div className="flex items-start gap-2">
            <GripVertical className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-foreground text-sm">{item.title}</p>
              {item.description && (
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {item.description}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ============================================================================
// useKanban - Hook for managing kanban state
// ============================================================================

interface UseKanbanOptions<T extends KanbanItem> {
  initialItems: T[]
  onItemMoved?: (item: T, fromColumn: string, toColumn: string) => void
}

interface UseKanbanReturn<T extends KanbanItem> {
  items: T[]
  moveItem: (itemId: string, toColumnId: string) => void
  addItem: (item: T) => void
  updateItem: (itemId: string, updates: Partial<T>) => void
  removeItem: (itemId: string) => void
}

export function useKanban<T extends KanbanItem>({
  initialItems,
  onItemMoved,
}: UseKanbanOptions<T>): UseKanbanReturn<T> {
  const [items, setItems] = useState<T[]>(initialItems)

  const moveItem = useCallback((itemId: string, toColumnId: string) => {
    setItems((prev) => {
      const item = prev.find((i) => i.id === itemId)
      if (!item || item.columnId === toColumnId) return prev

      const fromColumn = item.columnId
      const updated = prev.map((i) =>
        i.id === itemId ? { ...i, columnId: toColumnId } : i
      )

      onItemMoved?.({ ...item, columnId: toColumnId } as T, fromColumn, toColumnId)
      return updated
    })
  }, [onItemMoved])

  const addItem = useCallback((item: T) => {
    setItems((prev) => [...prev, item])
  }, [])

  const updateItem = useCallback((itemId: string, updates: Partial<T>) => {
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, ...updates } : i))
    )
  }, [])

  const removeItem = useCallback((itemId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId))
  }, [])

  return { items, moveItem, addItem, updateItem, removeItem }
}

export default KanbanBoard
