/**
 * AI Chat Schemas
 *
 * Pre-built collection schemas for DO-backed AI chat history.
 * The worker is the only writer; the client reads via `useQuery`.
 */

import type { CollectionSchema } from './registry'

// member.create is false on both collections: writes flow exclusively through
// the worker's /api/ai/* routes, which use X-App-Action to bypass RBAC.
// Allowing direct WS creates would let a user PUT fake `role: 'assistant'`
// rows into their own chats and have the next turn's loadMessages feed them
// to the LLM as if they were real assistant outputs.
export const AI_CHATS_SCHEMA: CollectionSchema = {
  name: 'ai-chats',
  columns: [
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'title', storage: 'text', interpretation: 'plain' },
    { name: 'model', storage: 'text', interpretation: 'plain' },
    { name: 'compactedSummary', storage: 'text', interpretation: 'plain' },
    { name: 'compactedThroughId', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'userId',
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'own', create: false, update: 'own', delete: 'own' },
    viewer: { read: 'own', create: false, update: false, delete: false },
  },
}

export const AI_MESSAGES_SCHEMA: CollectionSchema = {
  name: 'ai-messages',
  columns: [
    { name: 'chatId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', userBound: true, immutable: true, required: true },
    { name: 'role', storage: 'text', interpretation: 'plain', required: true },
    { name: 'content', storage: 'text', interpretation: 'plain' },
    { name: 'parts', storage: 'text', interpretation: { kind: 'json' } },
  ],
  ownerField: 'userId',
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'own', create: false, update: 'own', delete: 'own' },
    viewer: { read: 'own', create: false, update: false, delete: false },
  },
}
