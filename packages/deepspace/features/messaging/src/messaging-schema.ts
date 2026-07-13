/**
 * Messaging Feature — Schema
 *
 * Re-exports the SDK's pre-built messaging collection schemas.
 * Spread into the app's schemas array: ...messagingSchemas
 */

import type { CollectionSchema } from 'deepspace/worker'
import {
  CHANNELS_SCHEMA,
  MESSAGES_SCHEMA,
  REACTIONS_SCHEMA,
  CHANNEL_MEMBERS_SCHEMA,
  CHANNEL_INVITATIONS_SCHEMA,
  READ_RECEIPTS_SCHEMA,
} from 'deepspace/worker'

export const messagingSchemas: CollectionSchema[] = [
  CHANNELS_SCHEMA,
  MESSAGES_SCHEMA,
  REACTIONS_SCHEMA,
  CHANNEL_MEMBERS_SCHEMA,
  CHANNEL_INVITATIONS_SCHEMA,
  READ_RECEIPTS_SCHEMA,
]
