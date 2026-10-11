/**
 * deepspace/native — DeepSpace for React Native (Expo SDK 57).
 *
 * One import path for a native app: the Expo auth client, React bindings for
 * auth state, real-time records, app files, messaging, integrations, and
 * server actions.
 * Import everything from here (not also from `deepspace/expo`) so the app
 * holds a single copy of the client classes.
 *
 * This bundle compiles the same storage engine as `deepspace`. Where shared
 * code depends on the browser, the build substitutes a sibling `*.native.ts`
 * module (see `native/build-plugin.ts`): auth comes from the SecureStore-backed
 * Expo session, the app origin from the client's `baseUrl`, and foreground
 * reconnects from React Native's AppState.
 *
 * @example
 * ```tsx
 * import { createDeepSpaceExpoClient, DeepSpaceNativeProvider, RecordProvider, RecordScope } from 'deepspace/native'
 *
 * const deepSpace = createDeepSpaceExpoClient({ baseUrl: 'https://my-app.app.space' })
 *
 * export default function App() {
 *   return (
 *     <DeepSpaceNativeProvider client={deepSpace}>
 *       <RecordProvider>
 *         <RecordScope roomId={`app:${APP_ID}`} schemas={schemas}>
 *           <Home />
 *         </RecordScope>
 *       </RecordProvider>
 *     </DeepSpaceNativeProvider>
 *   )
 * }
 * ```
 */

// Auth client (the same implementation as `deepspace/expo`)
export { createDeepSpaceExpoClient } from './native/client'
export {
  DeepSpaceExpoClient,
  DeepSpaceExpoError,
  DeepSpaceSignInCancelledError,
  buildExpoOAuthStartUrl,
  codeFromExpoRedirect,
  normalizeExpoBaseUrl,
  stateFromExpoRedirect,
} from './expo'
export type {
  DeepSpaceExpoClientOptions,
  DeepSpaceExpoSession,
  DeepSpaceExpoSessionListener,
  DeepSpaceExpoUser,
  ExpoAuthPaths,
  ExpoAuthProvider,
  ExpoAuthStorage,
} from './expo'

// Provider and auth state
export { DeepSpaceNativeProvider, useDeepSpace } from './native/provider'
export type { DeepSpaceNativeProviderProps, DeepSpaceNative } from './native/provider'
export { useAuth } from './native/session'
export type { NativeAuthState } from './native/session'

// Real-time records
export { RecordProvider } from './client/storage/context'
export { RecordScope } from './native/RecordScope'
export type { RecordScopeProps } from './native/RecordScope'
export { useQuery } from './client/storage/hooks/useQuery'
export { useMutations } from './client/storage/hooks/useMutations'
export { useUser } from './client/storage/hooks/useUser'
export { useUsers } from './client/storage/hooks/useUsers'
export { useUserLookup, type UserInfo } from './client/storage/hooks/useUserLookup'
export { usePresence } from './client/storage/hooks/usePresence'
export { RecordRoomNotReadyError, WriteUnconfirmedError } from './client/storage/errors'
export { accountRoomId } from './shared/account-room'
export { type ConnectionStatus, toConnectionStatus } from './client/storage/connection-status'
export type {
  Query,
  RecordData,
  RecordProviderProps,
  RoomUser,
  User,
  UserProfile,
  WriteError,
} from './client/storage/types'
export type { CollectionSchema } from './shared/types'

// App files
export { useFileSource } from './native/files'
export type { FileSource, FileSourceOptions } from './native/files'

// Messaging
export { useMessages } from './client/messaging/useMessages'
export { useChannels } from './client/messaging/useChannels'
export { useReactions } from './client/messaging/useReactions'
export { useChannelMembers } from './client/messaging/useChannelMembers'
export { useReadReceipts } from './client/messaging/useReadReceipts'
export type {
  Channel,
  ChannelMember,
  GroupedReaction,
  Message,
  Reaction,
  ReadReceipt,
} from './client/messaging/channel-types'

// Integrations and server actions
export { integration } from './client/integration'
export { consentUrlOf, openIntegrationConsent } from './native/consent'
export { callAction } from './native/actions'
export type { ActionResult } from './native/actions'

// Keyboard, pointer and context-menu input
export { useKeyboardShortcuts, type KeyboardShortcutOptions } from './client/input/use-keyboard-shortcuts'
export type { KeyboardShortcut, ShortcutKey, ShortcutModifier } from './client/input/shortcuts'
export { ContextMenu } from './client/input/context-menu'
export type { ContextMenuItem, ContextMenuProps } from './client/input/context-menu-types'
export { isIOSAppOnMac, pointerInput } from './client/input/platform'

// Dialogs
export { Alert } from './native/alert'
