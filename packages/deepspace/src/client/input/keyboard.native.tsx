/**
 * Keyboard shortcuts on iPhone, iPad and the iPad app on a Mac, from a
 * hardware keyboard. The root is a native view (ios/DeepSpaceKeyboardModule)
 * that holds keyboard focus whenever nothing else does and turns the
 * registered key combinations into `UIKeyCommand`s. While a text field inside
 * it is being typed in, only the `whileTyping` shortcuts apply.
 */
import { useState, useSyncExternalStore, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { View, type NativeSyntheticEvent, type ViewProps } from 'react-native'
import { requireNativeView, requireOptionalNativeModule } from 'expo'
import { ShortcutRegistry, type ShortcutSpec } from './shortcuts'
import { ShortcutContext } from './use-keyboard-shortcuts'

interface NativeKeyboardProps extends ViewProps {
  shortcuts: ShortcutSpec[]
  onShortcut: (event: NativeSyntheticEvent<{ id: string; typing: boolean }>) => void
  children?: ReactNode
}

/** Undefined until first looked up; null when the binary lacks the module. */
let nativeView: ComponentType<NativeKeyboardProps> | null | undefined

/** The native view, or null in a binary built before the SDK shipped it (shortcuts then do nothing). */
function keyboardView(): ComponentType<NativeKeyboardProps> | null {
  if (nativeView === undefined) {
    const found = requireOptionalNativeModule('DeepSpaceKeyboard')
      ? requireNativeView<NativeKeyboardProps>('DeepSpaceKeyboard')
      : null
    if (!found && typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[deepspace/native] keyboard shortcuts need a native rebuild (npx expo run:ios) to include the DeepSpace module.')
    }
    nativeView = found
  }
  return nativeView
}

export function KeyboardShortcutsRoot({ children }: { children?: ReactNode }): ReactElement {
  const [registry] = useState(() => new ShortcutRegistry())
  const shortcuts = useSyncExternalStore(registry.subscribe, registry.snapshot)
  const Native = keyboardView()
  return (
    <ShortcutContext.Provider value={registry}>
      {Native ? (
        <Native
          style={{ flex: 1 }}
          shortcuts={shortcuts}
          onShortcut={(event) => registry.run(event.nativeEvent.id, event.nativeEvent.typing)}
        >
          {children}
        </Native>
      ) : (
        <View style={{ flex: 1 }}>{children}</View>
      )}
    </ShortcutContext.Provider>
  )
}
