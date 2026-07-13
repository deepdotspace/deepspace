/**
 * Tree Sidebar - Hooks
 *
 * Drag and drop hooks for reordering items in a tree structure.
 */

import React, { useState, useCallback, useRef } from 'react'

interface DragItem {
  id: string
  [key: string]: unknown
}

interface DragDropState {
  dragging: DragItem | null
  over: DragItem | null
}

interface DragHandlers {
  onDragStart: (e: React.DragEvent, item: DragItem) => void
  onDragOver: (e: React.DragEvent, item: DragItem) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent, item: DragItem) => void
  onDragEnd: () => void
}

/**
 * Hook for drag-and-drop reordering of items.
 * Supports multi-select drag when selectedIds is provided.
 */
export function useDragDrop<T extends DragItem>(
  items: T[],
  setItems: (items: T[]) => void,
  onReorder?: () => void,
  selectedIds: string[] = []
): {
  draggedItem: DragItem | null
  dragOverItem: DragItem | null
  handlers: DragHandlers
} {
  const [dragState, setDragState] = useState<DragDropState>({ dragging: null, over: null })
  const dragRef = useRef<DragDropState>({ dragging: null, over: null })

  const handleDragStart = useCallback((e: React.DragEvent, item: DragItem) => {
    dragRef.current.dragging = item
    setDragState(prev => ({ ...prev, dragging: item }))

    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.id)
    e.dataTransfer.setData('application/x-item', item.id)

    const isMultiDrag = selectedIds.includes(item.id) && selectedIds.length > 1
    const dragCount = isMultiDrag ? selectedIds.length : 1

    const ghost = document.createElement('div')
    ghost.style.cssText = `
      position: fixed;
      top: -1000px;
      left: -1000px;
      padding: 8px 12px;
      background: var(--color-primary);
      color: var(--color-primary-foreground);
      border-radius: 8px;
      font: 13px -apple-system, system-ui, sans-serif;
      font-weight: 500;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      pointer-events: none;
      white-space: nowrap;
    `

    if (isMultiDrag) {
      ghost.textContent = `${dragCount} items`
    } else {
      ghost.textContent = ((item as Record<string, unknown>).title as string || 'Item').slice(0, 25)
    }

    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 0, 0)

    setTimeout(() => {
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost)
    }, 0)
  }, [selectedIds])

  const handleDragOver = useCallback((e: React.DragEvent, item: DragItem) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'

    if (dragRef.current.over?.id !== item.id && dragRef.current.dragging?.id !== item.id) {
      dragRef.current.over = item
      setDragState(prev => ({ ...prev, over: item }))
    }
  }, [])

  const handleDragLeave = useCallback(() => {
    dragRef.current.over = null
    setDragState(prev => ({ ...prev, over: null }))
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, dropTarget: DragItem) => {
    e.preventDefault()

    const draggedItem = dragRef.current.dragging

    dragRef.current = { dragging: null, over: null }
    setDragState({ dragging: null, over: null })

    if (!draggedItem || !dropTarget || draggedItem.id === dropTarget.id) {
      return
    }

    const list = [...(items || [])]
    const fromIndex = list.findIndex(t => t.id === draggedItem.id)
    const toIndex = list.findIndex(t => t.id === dropTarget.id)

    if (fromIndex !== -1 && toIndex !== -1) {
      const [moved] = list.splice(fromIndex, 1)
      list.splice(toIndex, 0, moved)
      const reordered = list.map((item, i) => ({ ...item, order: i }))
      setItems(reordered as T[])
      if (onReorder) onReorder()
    }
  }, [items, setItems, onReorder])

  const handleDragEnd = useCallback(() => {
    dragRef.current = { dragging: null, over: null }
    setDragState({ dragging: null, over: null })
  }, [])

  return {
    draggedItem: dragState.dragging,
    dragOverItem: dragState.over,
    handlers: {
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      onDragEnd: handleDragEnd,
    },
  }
}

/**
 * Hook for hierarchical drag-and-drop with before/after/inside positions.
 * Used for tree structures like project hierarchies.
 */
export function useTreeDragDrop(
  onReorder?: (draggedId: string, targetId: string | null, position: 'before' | 'after' | 'inside') => void
) {
  const [dragState, setDragState] = useState<{
    draggingId: string | null
    dropTargetId: string | null
    dropPosition: 'before' | 'after' | 'inside' | null
  }>({
    draggingId: null,
    dropTargetId: null,
    dropPosition: null,
  })

  const handleDragStart = useCallback((e: React.DragEvent, node: { id: string; title?: string; color?: string }) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', node.id)
    setDragState(prev => ({ ...prev, draggingId: node.id }))

    const ghost = document.createElement('div')
    ghost.textContent = (node.title || 'Item').slice(0, 30)
    ghost.style.cssText = `
      position: fixed;
      top: -1000px;
      left: -1000px;
      padding: 6px 10px;
      background: ${node.color || '#007AFF'};
      color: white;
      border-radius: 6px;
      font: 13px -apple-system, system-ui, sans-serif;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      pointer-events: none;
      white-space: nowrap;
    `
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 0, 0)

    setTimeout(() => {
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost)
    }, 0)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.stopPropagation()

    if (!dragState.draggingId || dragState.draggingId === targetId) return

    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const height = rect.height

    let position: 'before' | 'after' | 'inside'
    if (y < height * 0.25) {
      position = 'before'
    } else if (y > height * 0.75) {
      position = 'after'
    } else {
      position = 'inside'
    }

    setDragState(prev => ({ ...prev, dropTargetId: targetId, dropPosition: position }))
  }, [dragState.draggingId])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragState(prev => ({ ...prev, dropTargetId: null, dropPosition: null }))
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.stopPropagation()

    const { draggingId, dropPosition } = dragState
    if (!draggingId || !targetId || draggingId === targetId || !dropPosition) {
      setDragState({ draggingId: null, dropTargetId: null, dropPosition: null })
      return
    }

    if (onReorder) {
      onReorder(draggingId, targetId, dropPosition)
    }

    setDragState({ draggingId: null, dropTargetId: null, dropPosition: null })
  }, [dragState, onReorder])

  const handleDragEnd = useCallback(() => {
    setDragState({ draggingId: null, dropTargetId: null, dropPosition: null })
  }, [])

  const handleRootDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const { draggingId } = dragState
    if (draggingId && onReorder) {
      onReorder(draggingId, null, 'inside')
    }
    setDragState({ draggingId: null, dropTargetId: null, dropPosition: null })
  }, [dragState, onReorder])

  return {
    dragState,
    handlers: {
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      onDragEnd: handleDragEnd,
      onRootDrop: handleRootDrop,
    },
  }
}
