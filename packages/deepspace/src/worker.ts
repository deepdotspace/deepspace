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
export * from './shared/app-routing'
export * from './shared/platform-proxy'
export { authenticatedRoomRequest } from './shared/room-identity-headers'
export * from './server/utils'
export {
  registerDeepSpaceDocumentation,
  type DeepSpaceDocumentationRouteEnv,
  type DeepSpaceDocumentationRouteOptions,
} from './documentation/worker/routes'
export * from './server/auth'
export { SYSTEM_COLLECTIONS } from './server/handlers/yjs'
export {
  registerAgentToolRoutes,
  createUserToolExecutor,
  AGENT_TOOL_REQUEST_BODY_CAP,
  AGENT_TOOL_RESPONSE_BODY_CAP,
  type AgentToolAccessResult,
  type AgentToolRouteEnv,
  type AgentToolRouteOptions,
  type UserToolExecutorEnv,
} from './server/agent-tools'
export {
  normalizeAgentTargetOrigin,
  PRODUCTION_OFFICIAL_AGENT_ORIGINS,
  type AgentTargetPolicy,
} from './server/agent-target'
export { SESSION_COOKIE } from './shared/auth-session'
// `deepspace logs` wire DTO — the single source of truth shared with the CLI,
// the dashboard, and the platform telemetry reader (deploy-worker).
export * from './shared/log-events'
// The one `app.onError` for Hono workers (template and platform alike).
export { workerErrorHandler } from './server/worker-error'
// Not routed through the files handler's re-export like the app-files limits:
// this one bounds the REPO store, a different allocation with a different
// writer (platform/deploy-worker/src/vc/storage-quota.ts).
export { REPO_STORE_LIMIT_BYTES } from './shared/app-files'
