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
export * from './server/utils'
export * from './server/auth'
export { SYSTEM_COLLECTIONS } from './server/handlers/yjs'
