/**
 * AI Chat Feature — Schema
 *
 * Re-exports the SDK's pre-built AI chat collection schemas.
 * Spread into the app's schemas array: ...aiChatSchemas
 */

import type { CollectionSchema } from 'deepspace/worker'
import { AI_CHATS_SCHEMA, AI_MESSAGES_SCHEMA } from 'deepspace/worker'

export const aiChatSchemas: CollectionSchema[] = [AI_CHATS_SCHEMA, AI_MESSAGES_SCHEMA]
