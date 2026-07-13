/**
 * Tree Sidebar - Hierarchical Navigation + Drag & Drop
 *
 * Features:
 * - Main navigation views (All, Today, Upcoming, Logbook, Trash)
 * - Hierarchical project tree with drag-and-drop reordering
 * - User list with task assignment via drag-and-drop
 * - Collapsible sections
 */

import React, { useState, useEffect, useCallback, type ReactNode } from 'react'
import { VIEWS, VIEW_CONFIG, type CurrentView, type ViewType } from './tree-constants'
import { useTreeDragDrop } from './tree-hooks'

// ============================================================================
// Types
// ============================================================================

interface ProjectNode {
  id: string
  title: string
  color?: string
  parentId?: string | null
  children?: ProjectNode[]
  totalTaskCount?: number
  totalCompleted?: number
}

interface User {
  id: string
  name?: string
  email?: string
  color?: string
  imageUrl?: string
  isCustom?: boolean
}

interface TaskCounts {
  [key: string]: { total: number; completed: number; uncompleted: number } | number
}

interface TreeSidebarProps {
  currentView: CurrentView
  onViewChange: (view: CurrentView) => void
  taskCounts?: TaskCounts
  projectTree?: ProjectNode[]
  onAddProject?: (parentId: string | null) => void
  onEditProject?: (project: ProjectNode) => void
  onReorderProject?: (draggedId: string, targetId: string | null, position: 'before' | 'after' | 'inside') => void
  onItemDrop?: (itemId: string, projectId: string) => void
  onItemDropOnUser?: (itemId: string, userId: string | null) => void
  onItemDragEnd?: () => void
  allUsers?: User[]
  currentUser?: User
  onManageUsers?: () => void
  width?: number
  isReadOnly?: boolean
  getDisplayName?: (user: User) => string
  header?: ReactNode
  footer?: ReactNode
}

// ============================================================================
// Icon Component
// ============================================================================

interface IconProps {
  name: string
  size?: number
  className?: string
  style?: React.CSSProperties
}

function Icon({ name, size = 16, className = '', style }: IconProps) {
  const iconMap: Record<string, ReactNode> = {
    list: (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    ),
    star: (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
    calendar: (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
    'book-open': (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
    ),
    'trash-2': (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    ),
    'chevron-right': (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    ),
    'chevron-down': (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    ),
    plus: (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    ),
    pencil: (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
      </svg>
    ),
    users: (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    'user-plus': (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" />
      </svg>
    ),
  }

  return <>{iconMap[name] || <span style={{ width: size, height: size }} />}</>
}

// ============================================================================
// Project Tree Node
// ============================================================================

interface ProjectTreeNodeProps {
  node: ProjectNode
  depth: number
  currentView: CurrentView
  onViewChange: (view: CurrentView) => void
  expandedProjects: Record<string, boolean>
  toggleExpand: (id: string) => void
  onAddProject?: (parentId: string | null) => void
  onEditProject?: (project: ProjectNode) => void
  dragState: ReturnType<typeof useTreeDragDrop>['dragState']
  dragHandlers: ReturnType<typeof useTreeDragDrop>['handlers']
  onItemDrop?: (itemId: string, projectId: string) => void
  onItemDragEnd?: () => void
  isReadOnly?: boolean
}

function ProjectTreeNode({
  node, depth, currentView, onViewChange, expandedProjects, toggleExpand,
  onAddProject, onEditProject, dragState, dragHandlers, onItemDrop, onItemDragEnd, isReadOnly,
}: ProjectTreeNodeProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [isItemDragOver, setIsItemDragOver] = useState(false)

  const isActive = currentView.type === VIEWS.PROJECT && currentView.id === node.id
  const isExpanded = expandedProjects[node.id]
  const hasChildren = node.children && node.children.length > 0
  const isDragging = dragState.draggingId === node.id
  const isDropTarget = dragState.dropTargetId === node.id
  const dropPosition = isDropTarget ? dragState.dropPosition : null

  const handleDragOver = (e: React.DragEvent) => {
    if (isReadOnly) return
    const isItemDrag = e.dataTransfer.types.includes('application/x-item')
    if (isItemDrag) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (!isItemDragOver) setIsItemDragOver(true)
    } else {
      dragHandlers.onDragOver(e, node.id)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (isReadOnly) return
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsItemDragOver(false)
      dragHandlers.onDragLeave(e)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    if (isReadOnly) return
    const itemId = e.dataTransfer.getData('application/x-item')
    if (itemId && onItemDrop) {
      e.preventDefault()
      e.stopPropagation()
      onItemDrop(itemId, node.id)
      setIsItemDragOver(false)
      if (onItemDragEnd) onItemDragEnd()
    } else {
      dragHandlers.onDrop(e, node.id)
    }
  }

  return (
    <div style={{ opacity: isDragging ? 0.5 : 1 }}>
      <div
        draggable={!isReadOnly}
        onDragStart={(e) => !isReadOnly && dragHandlers.onDragStart(e, node)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={dragHandlers.onDragEnd}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={`
          flex items-center gap-1 py-1.5 px-2 rounded-md transition-colors cursor-grab relative
          ${isActive ? 'bg-primary/10' : ''}
          ${isItemDragOver ? 'bg-primary/10' : ''}
        `}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {dropPosition === 'before' && (
          <div className="absolute left-2 right-2 top-0 h-0.5 bg-primary rounded" />
        )}
        {dropPosition === 'after' && (
          <div className="absolute left-2 right-2 bottom-0 h-0.5 bg-primary rounded" />
        )}
        {dropPosition === 'inside' && (
          <div className="absolute inset-1 border-2 border-dashed border-primary rounded pointer-events-none" />
        )}

        <button
          onClick={(e) => { e.stopPropagation(); toggleExpand(node.id) }}
          className="w-4 h-4 flex items-center justify-center flex-shrink-0"
        >
          {hasChildren ? (
            <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} className="text-muted-foreground" />
          ) : (
            <span className="w-3" />
          )}
        </button>

        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: node.color || 'var(--color-primary)' }}
        />

        <button
          onClick={() => onViewChange({ type: VIEWS.PROJECT, id: node.id })}
          className="flex-1 text-left min-w-0"
        >
          <span className="text-sm text-foreground truncate block">{node.title}</span>
        </button>

        {(node.totalTaskCount ?? 0) > 0 && (
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {(node.totalTaskCount ?? 0) - (node.totalCompleted ?? 0)}/{node.totalTaskCount}
          </span>
        )}

        {!isReadOnly && (
          <div className={`flex items-center gap-0.5 ml-auto transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
            {onAddProject && (
              <button
                onClick={(e) => { e.stopPropagation(); onAddProject(node.id) }}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted"
                title="Add sub-project"
              >
                <Icon name="plus" size={12} className="text-muted-foreground" />
              </button>
            )}
            {onEditProject && (
              <button
                onClick={(e) => { e.stopPropagation(); onEditProject(node) }}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted"
                title="Edit project"
              >
                <Icon name="pencil" size={12} className="text-muted-foreground" />
              </button>
            )}
          </div>
        )}
      </div>

      {isExpanded && hasChildren && (
        <div>
          {node.children!.map(child => (
            <ProjectTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              currentView={currentView}
              onViewChange={onViewChange}
              expandedProjects={expandedProjects}
              toggleExpand={toggleExpand}
              onAddProject={onAddProject}
              onEditProject={onEditProject}
              dragState={dragState}
              dragHandlers={dragHandlers}
              onItemDrop={onItemDrop}
              onItemDragEnd={onItemDragEnd}
              isReadOnly={isReadOnly}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// User List Item
// ============================================================================

interface UserListItemProps {
  user: User
  isActive: boolean
  isYou: boolean
  displayName: string
  taskCount?: { total: number; completed: number }
  onViewChange: (view: CurrentView) => void
  onItemDropOnUser?: (itemId: string, userId: string | null) => void
  onItemDragEnd?: () => void
  isReadOnly?: boolean
}

function UserListItem({
  user, isActive, isYou, displayName, taskCount, onViewChange,
  onItemDropOnUser, onItemDragEnd, isReadOnly,
}: UserListItemProps) {
  const [isItemDragOver, setIsItemDragOver] = useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    if (isReadOnly) return
    const isItemDrag = e.dataTransfer.types.includes('application/x-item')
    if (isItemDrag) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      if (!isItemDragOver) setIsItemDragOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    if (isReadOnly) return
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsItemDragOver(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    if (isReadOnly) return
    const itemId = e.dataTransfer.getData('application/x-item')
    if (itemId && onItemDropOnUser) {
      e.preventDefault()
      e.stopPropagation()
      onItemDropOnUser(itemId, user.id)
      setIsItemDragOver(false)
      if (onItemDragEnd) onItemDragEnd()
    }
  }

  const total = taskCount?.total ?? 0
  const completed = taskCount?.completed ?? 0

  return (
    <button
      onClick={() => onViewChange({ type: VIEWS.USER, id: user.id })}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        w-full flex items-center gap-2.5 py-1.5 px-2.5 rounded-md transition-colors text-left
        ${isActive ? 'bg-black/5' : 'hover:bg-black/[0.02]'}
        ${isItemDragOver ? 'bg-primary/10 ring-2 ring-primary/30' : ''}
      `}
    >
      <span
        className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-semibold text-white flex-shrink-0"
        style={{ backgroundColor: user.color || 'var(--color-primary)' }}
      >
        {displayName?.charAt(0).toUpperCase() || '?'}
      </span>
      <span className="flex-1 text-sm text-foreground truncate">{displayName}</span>
      {isYou && (
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
          You
        </span>
      )}
      {total > 0 && (
        <span className="text-xs text-muted-foreground">{total - completed}/{total}</span>
      )}
    </button>
  )
}

// ============================================================================
// Main Sidebar Component
// ============================================================================

export default function TreeSidebar({
  currentView, onViewChange, taskCounts = {}, projectTree = [],
  onAddProject, onEditProject, onReorderProject, onItemDrop, onItemDropOnUser,
  onItemDragEnd, allUsers = [], currentUser, onManageUsers, width = 260,
  isReadOnly = false, getDisplayName, header, footer,
}: TreeSidebarProps) {
  const [expandedSections, setExpandedSections] = useState({ projects: true, users: true })
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({})

  const { dragState, handlers: dragHandlers } = useTreeDragDrop(onReorderProject)

  // Auto-expand parents of active project
  useEffect(() => {
    if (currentView.type === VIEWS.PROJECT && currentView.id) {
      const findPath = (nodes: ProjectNode[], targetId: string, path: string[] = []): string[] | null => {
        for (const node of nodes) {
          if (node.id === targetId) return path
          if (node.children) {
            const found = findPath(node.children, targetId, [...path, node.id])
            if (found) return found
          }
        }
        return null
      }
      const path = findPath(projectTree, currentView.id)
      if (path) {
        setExpandedProjects(prev => {
          const next = { ...prev }
          path.forEach(id => { next[id] = true })
          return next
        })
      }
    }
  }, [currentView, projectTree])

  const toggleSection = (section: 'projects' | 'users') => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const toggleExpand = useCallback((projectId: string) => {
    setExpandedProjects(prev => ({ ...prev, [projectId]: !prev[projectId] }))
  }, [])

  const mainViews: Array<{ type: ViewType; icon: string; color: string }> = [
    { type: VIEWS.ALL, icon: 'list', color: '#6366f1' },
    { type: VIEWS.TODAY, icon: 'star', color: '#f59e0b' },
    { type: VIEWS.UPCOMING, icon: 'calendar', color: '#ef4444' },
    { type: VIEWS.LOGBOOK, icon: 'book-open', color: '#9ca3af' },
    { type: VIEWS.TRASH, icon: 'trash-2', color: '#9ca3af' },
  ]

  return (
    <div
      className="h-full bg-card border-r border-border flex flex-col overflow-auto flex-shrink-0"
      style={{ width }}
    >
      {header}

      <nav className="p-3 flex flex-col gap-0.5">
        {mainViews.map(({ type, icon, color }) => {
          const config = VIEW_CONFIG[type]
          const isActive = currentView.type === type
          const countData = taskCounts[type]
          const count = typeof countData === 'number' ? countData : (countData?.total ?? 0)
          const completed = typeof countData === 'number' ? 0 : (countData?.completed ?? 0)
          const uncompleted = count - completed
          const countDisplay = count > 0 ? `${uncompleted}/${count}` : null

          return (
            <button
              key={type}
              onClick={() => onViewChange({ type })}
              className={`
                flex items-center gap-2.5 px-2.5 py-2 rounded-lg w-full text-left transition-colors
                ${isActive ? 'bg-black/[0.06]' : 'hover:bg-black/[0.02]'}
              `}
            >
              <span className="w-6 h-6 rounded-md flex items-center justify-center">
                <Icon name={icon} size={16} className={isActive ? 'text-primary' : ''} style={{ color }} />
              </span>
              <span className={`flex-1 text-sm ${isActive ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                {config?.title ?? type}
              </span>
              {countDisplay && (
                <span className="text-xs text-muted-foreground">
                  {countDisplay}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="h-px bg-border mx-4 my-2" />

      {/* Projects Section */}
      <div className="flex flex-col">
        <button onClick={() => toggleSection('projects')} className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Icon name={expandedSections.projects ? 'chevron-down' : 'chevron-right'} size={14} className="text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Projects</span>
          </div>
          {!isReadOnly && onAddProject && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddProject(null) }}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-muted"
              title="Add Project"
            >
              <Icon name="plus" size={14} className="text-muted-foreground" />
            </button>
          )}
        </button>

        {expandedSections.projects && (
          <div
            className="px-1 pb-2 min-h-[40px]"
            onDragOver={(e) => e.preventDefault()}
            onDrop={dragHandlers.onRootDrop}
          >
            {projectTree.length > 0 ? (
              projectTree.map(node => (
                <ProjectTreeNode
                  key={node.id}
                  node={node}
                  depth={0}
                  currentView={currentView}
                  onViewChange={onViewChange}
                  expandedProjects={expandedProjects}
                  toggleExpand={toggleExpand}
                  onAddProject={onAddProject}
                  onEditProject={onEditProject}
                  dragState={dragState}
                  dragHandlers={dragHandlers}
                  onItemDrop={onItemDrop}
                  onItemDragEnd={onItemDragEnd}
                  isReadOnly={isReadOnly}
                />
              ))
            ) : (
              <div className="text-xs text-muted-foreground px-2.5 py-2 italic">No projects yet</div>
            )}
          </div>
        )}
      </div>

      <div className="h-px bg-border mx-4 my-2" />

      {/* Users Section */}
      <div className="flex flex-col">
        <button onClick={() => toggleSection('users')} className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Icon name={expandedSections.users ? 'chevron-down' : 'chevron-right'} size={14} className="text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">By User</span>
          </div>
          {!isReadOnly && onManageUsers && (
            <button
              onClick={(e) => { e.stopPropagation(); onManageUsers() }}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-muted"
              title="Manage Users"
            >
              <Icon name="users" size={14} className="text-muted-foreground" />
            </button>
          )}
        </button>

        {expandedSections.users && (
          <div className="px-1 pb-2">
            {allUsers.map(user => {
              const isYou = currentUser?.id === user.id
              const displayName = getDisplayName ? getDisplayName(user) : (user.name || user.email || 'Unknown')

              return (
                <UserListItem
                  key={user.id}
                  user={user}
                  isActive={currentView.type === VIEWS.USER && currentView.id === user.id}
                  isYou={isYou}
                  displayName={displayName}
                  onViewChange={onViewChange}
                  onItemDropOnUser={onItemDropOnUser}
                  onItemDragEnd={onItemDragEnd}
                  isReadOnly={isReadOnly}
                />
              )
            })}

            {!isReadOnly && allUsers.length === 0 && onManageUsers && (
              <button
                onClick={onManageUsers}
                className="w-full flex items-center justify-center gap-1.5 p-2.5 border border-dashed border-border rounded-lg text-primary text-sm hover:bg-primary/5"
              >
                <Icon name="user-plus" size={14} className="text-primary" />
                <span>Add users</span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1" />

      {footer}
    </div>
  )
}
