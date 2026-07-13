/**
 * deepspace — DeepSpace Client SDK
 *
 * Everything for React frontends.
 *
 * import { RecordProvider, useQuery, useAuth, useMessages, AuthOverlay } from 'deepspace'
 */
export type { CollectionSchema } from './shared/types'
export * from './shared/env'
export * from './shared/roles'
// Re-export the wire protocol layer (the `MSG` constants object, the
// `ClientMessage` / `ServerMessage` discriminated unions, `clientBuild`,
// `dispatch`, `encode`, etc.) so apps that build their own WebSocket
// layer against a DeepSpace DO speak the same typed vocabulary as the
// SDK's built-in hooks. The worker entry re-exports the same module, so
// both halves of a custom hook + custom room stay aligned.
export * from './shared/protocol'
export * from './client/auth'
export * from './client/storage'
export * from './client/messaging'
export * from './client/directory'
export * from './client/theme'
export * from './client/platform'
export * from './client/integration'
export * from './client/voice'
export * from './client/ai-stream'
export * from './client/status'
export * from './client/subscriptions'
export * from './client/charges'
