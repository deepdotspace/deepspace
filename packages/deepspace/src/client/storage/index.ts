/**
 * Core Storage Module
 *
 * RecordProvider, RecordScope, and primitive hooks for real-time data.
 */

// Providers
export { RecordProvider, useRecordContext } from './context'
export { RecordScope } from './RecordScope'
export { ScopeRegistryProvider } from './ScopeRegistry'
export type { ScopeEntry } from './ScopeRegistry'

// Core hooks
export { useUser } from './hooks/useUser'
export { useQuery } from './hooks/useQuery'
export { useMutations } from './hooks/useMutations'
export { useUsers } from './hooks/useUsers'
export { useYjsField, useYjsText, type UseYjsFieldResult, type UseYjsTextResult } from './hooks/useYjs'

// User lookup + presence
export { useUserLookup, type UserInfo } from './hooks/useUserLookup'
export { usePresence } from './hooks/usePresence'

// Dedicated YjsRoom hook (direct WebSocket to YjsRoom DO)
export { useYjsRoom, type UseYjsRoomResult } from './hooks/useYjsRoom'

// Room-specific hooks
export { useGameRoom, type UseGameRoomResult, type GamePlayer } from './hooks/useGameRoom'
export { useCanvas, type UseCanvasResult, type CanvasShapeClient, type ViewportClient } from './hooks/useCanvas'
export { useCronMonitor, type UseCronMonitorResult, type CronTaskState, type CronHistoryEntry } from './hooks/useCronMonitor'
export { useJobs, type UseJobsResult, type JobView, type JobStatusView } from './hooks/useJobs'
export { usePresenceRoom, type UsePresenceRoomResult, type PresencePeerClient } from './hooks/usePresenceRoom'

// Connection status
export { type ConnectionStatus, toConnectionStatus } from './connection-status'

// File uploads (R2)
export { useR2Files } from './useR2Files'
export type { R2FileInfo, R2UploadResult, UseR2FilesReturn, R2Scope } from './useR2Files'
export { isImageFile, formatFileSize } from './file-attachment-utils'
export type { FileAttachment } from './file-attachment-utils'

// User colors
export { getUserColor, DEFAULT_USER_COLORS } from './user-color'

// Types
export type {
  Query,
  RecordData,
  User,
  UserProfile,
  UserCredits,
  UserKarma,
  RoomUser,
  RecordProviderProps,
  FetchUserProfile,
} from './types'

// Yjs protocol (advanced)
export {
  MSG_SYNC, MSG_AWARENESS, MSG_SYNC_STEP1, MSG_SYNC_STEP2, MSG_SYNC_UPDATE,
  createEncoder, toUint8Array, writeVarUint, writeVarUint8Array,
  createDecoder, readVarUint, readVarUint8Array, hasContent,
  encodeSyncStep1, encodeSyncStep2, encodeUpdate, handleSyncMessage,
  type SyncResult,
  Awareness, encodeAwarenessMessage, handleAwarenessMessage, getMessageType,
  type AwarenessState, type AwarenessStates,
} from '../../shared/protocol/yjs'
