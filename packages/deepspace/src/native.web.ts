/**
 * deepspace/native in the browser: the web build of a React Native app.
 *
 * The package's `browser` export condition selects this entry when Metro
 * bundles the app for the web, so `import ... from 'deepspace/native'` works
 * unchanged on iPhone, iPad, Mac and the web. It exports exactly the names
 * `native.ts` does (native-web-bundle.test.ts checks), and its types are that
 * entry's, so see `native.ts` for the API. The browser implementations live in
 * `native/web.tsx`.
 */

// Auth client (in the browser, the page's own same-origin session)
export { createDeepSpaceExpoClient, DeepSpaceExpoClient } from './native/web'
export { DeepSpaceExpoError, DeepSpaceSignInCancelledError } from './expo-errors'
export {
  buildExpoOAuthStartUrl,
  codeFromExpoRedirect,
  normalizeExpoBaseUrl,
  stateFromExpoRedirect,
} from './expo-url'
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
export { DeepSpaceNativeProvider, useDeepSpace } from './native/web'
export type { DeepSpaceNativeProviderProps, DeepSpaceNative } from './native/provider'
export { useAuth } from './native/web'
export type { NativeAuthState } from './native/session'

// Real-time records
export { RecordProvider } from './client/storage/context'
// Same origin as the page, so the shared scope's default socket address is right.
export { RecordScope } from './client/storage/RecordScope'
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
export { useFileSource } from './native/web'
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
export { consentUrlOf } from './native/consent-url'
export { openIntegrationConsent } from './native/web'
export { callAction } from './native/web'
export type { ActionResult } from './native/actions'

// Keyboard, pointer and context-menu input
export { useKeyboardShortcuts, type KeyboardShortcutOptions } from './client/input/use-keyboard-shortcuts'
export type { KeyboardShortcut, ShortcutKey, ShortcutModifier } from './client/input/shortcuts'
export { ContextMenu } from './client/input/context-menu'
export type { ContextMenuItem, ContextMenuProps } from './client/input/context-menu-types'
export { isIOSAppOnMac, pointerInput } from './client/input/platform'

// Dialogs
export { Alert } from './native/web'
