/**
 * deepspace/schema — runtime-neutral collection declarations.
 *
 * Import the same schemas from browser and Worker code without loading either
 * runtime surface into the other bundle.
 */
export type {
  CollectionSchema,
  ColumnDefinition,
  ColumnInterpretation,
  PermissionLevel,
  RolePermissions,
} from './shared/types'
export { BASE_USERS_SCHEMA, USERS_COLUMNS } from './server/schemas/registry'
export { AI_CHATS_SCHEMA, AI_MESSAGES_SCHEMA } from './server/schemas/ai-chat'
export {
  CHANNELS_SCHEMA,
  MESSAGES_SCHEMA,
  REACTIONS_SCHEMA,
  CHANNEL_MEMBERS_SCHEMA,
  CHANNEL_INVITATIONS_SCHEMA,
  READ_RECEIPTS_SCHEMA,
} from './server/schemas/messaging'
export { CONVERSATION_SCHEMAS, VOTING_SCHEMAS } from './server/schemas/conversation'
export { DIRECTORY_SCHEMAS } from './server/schemas/directory'
export { WORKSPACE_SCHEMAS } from './server/schemas/workspace'
