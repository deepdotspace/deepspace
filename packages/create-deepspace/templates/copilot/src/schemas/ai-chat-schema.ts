/**
 * AI Chat Feature — Schema
 *
 * Re-exports the SDK's pre-built AI chat collection schemas.
 * Spread into the app's schemas array: ...aiChatSchemas
 */

import { AI_CHATS_SCHEMA, AI_MESSAGES_SCHEMA, type CollectionSchema } from 'deepspace/schema'

export const aiChatSchemas: CollectionSchema[] = [AI_CHATS_SCHEMA, AI_MESSAGES_SCHEMA]
