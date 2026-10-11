/**
 * The native context menu (`UIContextMenuInteraction`): a secondary click on a
 * Mac, touch and hold on iPhone and iPad.
 */
import type { ComponentType, ReactElement, ReactNode } from 'react'
import { View, type NativeSyntheticEvent, type ViewProps } from 'react-native'
import { requireNativeView, requireOptionalNativeModule } from 'expo'
import type { ContextMenuItem, ContextMenuProps } from './context-menu-types'

interface NativeMenuProps extends ViewProps {
  items: readonly ContextMenuItem[]
  enabled: boolean
  onSelect: (event: NativeSyntheticEvent<{ id: string }>) => void
  children?: ReactNode
}

/** Undefined until first looked up; null when the binary lacks the module. */
let nativeView: ComponentType<NativeMenuProps> | null | undefined

function menuView(): ComponentType<NativeMenuProps> | null {
  if (nativeView === undefined) {
    const found = requireOptionalNativeModule('DeepSpaceContextMenu')
      ? requireNativeView<NativeMenuProps>('DeepSpaceContextMenu')
      : null
    nativeView = found
  }
  return nativeView
}

export function ContextMenu({ items, enabled = true, onSelect, style, children }: ContextMenuProps): ReactElement {
  const Native = menuView()
  if (!Native) return <View style={style}>{children}</View>
  return (
    <Native style={style} items={items} enabled={enabled} onSelect={(event) => onSelect(event.nativeEvent.id)}>
      {children}
    </Native>
  )
}
