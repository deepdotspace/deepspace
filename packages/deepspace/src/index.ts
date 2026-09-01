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
export * from './shared/ai-models'
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
export * from './client/theme'
export * from './client/integration'
export * from './client/voice'
export * from './client/ai-stream'
export * from './client/status'
export * from './client/subscriptions'
export * from './client/charges'
// The typed error the billing hooks throw for a platform refusal — human
// `message` for rendering, machine `code` (e.g. 'owner_connect_not_ready')
// for branching. The normalizer behind it stays internal.
export { PlatformApiError } from './shared/api-error'
export type { NormalizedApiError, ApiErrorIssue } from './shared/api-error'
// `deepspace logs` wire DTO + the whitelisted key set — shared with the
// dashboard, the CLI, and the platform reader so the four never drift.
export * from './shared/log-events'
// The per-tier storage schedule the platform ACTUALLY admits against, so a
// surface that quotes capacity reads it instead of restating it. The billing
// page advertised 5 GB against an enforced 128 MiB for months precisely
// because those were two numbers instead of one.
export { ACCOUNT_STORAGE_LIMIT_BYTES, storageLimitForTier, formatBytes } from './shared/app-files'
