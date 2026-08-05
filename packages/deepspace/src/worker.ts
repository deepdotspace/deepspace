/**
 * deepspace/worker — DeepSpace Worker SDK
 *
 * Everything for Cloudflare Workers: RecordRoom, schemas, auth verification.
 *
 * import { RecordRoom, verifyJwt, CHANNELS_SCHEMA } from 'deepspace/worker'
 */
export * from './server/rooms'
export * from './server/schemas'
export * from './shared/protocol'
export * from './shared/ai-models'
export * from './server/utils'
export {
  registerDeepSpaceDocumentation,
  type DeepSpaceDocumentationRouteEnv,
  type DeepSpaceDocumentationRouteOptions,
} from './documentation/worker/routes'
export * from './server/auth'
export { SYSTEM_COLLECTIONS } from './server/handlers/yjs'
// Client-error ingestion (opt-in): the Worker route registrar + its handler,
// the shared report type, and the marker the platform reader keys on. Only the
// user-facing surface is public — the caps table, normalizer, log-line builder,
// and throttle hooks stay internal so the wire protocol isn't frozen as API.
export { registerClientErrorRoute, handleClientErrorReport } from './server/client-errors'
export { CLIENT_LOG_MARKER } from './shared/client-errors'
export type { ClientErrorReport, ClientErrorKind } from './shared/client-errors'
// `deepspace logs` wire DTO — the single source of truth shared with the CLI,
// the dashboard, and the platform telemetry reader (deploy-worker).
export * from './shared/log-events'
