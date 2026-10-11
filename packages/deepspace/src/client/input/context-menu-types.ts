import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

export interface ContextMenuItem {
  id: string
  title: string
  /** An SF Symbol name, shown natively; ignored in the browser. */
  icon?: string
  destructive?: boolean
  disabled?: boolean
}

export interface ContextMenuProps {
  items: readonly ContextMenuItem[]
  /**
   * Default true. On touch screens, touch and hold usually drags or swipes, so
   * apps often pass `pointerInput` to offer the menu only to a mouse or trackpad.
   */
  enabled?: boolean
  onSelect: (id: string) => void
  style?: StyleProp<ViewStyle>
  children?: ReactNode
}
