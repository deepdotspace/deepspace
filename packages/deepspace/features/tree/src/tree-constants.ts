/**
 * Tree Sidebar - Constants
 *
 * View types and configurations for tree sidebar navigation.
 */

export const VIEWS = {
  ALL: 'all',
  TODAY: 'today',
  UPCOMING: 'upcoming',
  LOGBOOK: 'logbook',
  TRASH: 'trash',
  PROJECT: 'project',
  USER: 'user',
} as const

export type ViewType = typeof VIEWS[keyof typeof VIEWS]

export interface ViewConfig {
  title: string
  icon: string
  color: string
  description: string
}

export const VIEW_CONFIG: Record<string, ViewConfig> = {
  [VIEWS.ALL]: {
    title: 'All Tasks',
    icon: 'list',
    color: '#6366f1',
    description: 'All your tasks',
  },
  [VIEWS.TODAY]: {
    title: 'Today',
    icon: 'star',
    color: '#f59e0b',
    description: 'Focus on what matters today',
  },
  [VIEWS.UPCOMING]: {
    title: 'calendar',
    icon: 'calendar',
    color: '#ef4444',
    description: 'Plan ahead',
  },
  [VIEWS.LOGBOOK]: {
    title: 'Logbook',
    icon: 'book-open',
    color: '#9ca3af',
    description: 'Completed tasks',
  },
  [VIEWS.TRASH]: {
    title: 'Trash',
    icon: 'trash-2',
    color: '#9ca3af',
    description: 'Deleted tasks',
  },
}

export interface CurrentView {
  type: ViewType
  id?: string
}

export interface DragState {
  draggingId: string | null
  dropTargetId: string | null
  dropPosition: 'before' | 'after' | 'inside' | null
}
