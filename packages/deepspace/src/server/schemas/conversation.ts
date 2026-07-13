/**
 * Shared conversation schemas for RecordRoom-based conversations.
 *
 * These define the collections inside a per-conversation RecordRoom DO.
 * Used by apps that have messaging/conversation features (slack-clone,
 * helpdesk, mail, reddit-clone, etc.).
 *
 * Each conversation gets its own RecordRoom DO keyed by `conv:{id}`.
 */

import type { CollectionSchema } from './registry'

// Re-export data interfaces from types (single source of truth)
export type {
  ConvMessageData,
  ConvReactionData,
  ConvMemberData,
  ConvReadCursorData,
  ConvVoteData,
} from '../../shared/types'

// ============================================================================
// Schemas
// ============================================================================

export const CONVERSATION_SCHEMAS: CollectionSchema[] = [
  {
    name: 'conv_messages',
    columns: [
      { name: 'Content', storage: 'text', interpretation: 'plain' },
      { name: 'AuthorId', storage: 'text', interpretation: 'plain' },
      { name: 'ParentId', storage: 'text', interpretation: 'plain' },
      { name: 'Edited', storage: 'number', interpretation: 'boolean' },
      { name: 'MessageType', storage: 'text', interpretation: 'plain' },
      { name: 'Metadata', storage: 'text', interpretation: 'json' },
    ],
    permissions: {
      viewer: { read: true, create: false, update: false, delete: false },
      member: { read: true, create: true, update: 'own', delete: 'own' },
      admin: { read: true, create: true, update: true, delete: true },
    },
    ownerField: 'AuthorId',
  },
  {
    name: 'conv_reactions',
    columns: [
      { name: 'MessageId', storage: 'text', interpretation: 'plain' },
      { name: 'Emoji', storage: 'text', interpretation: 'plain' },
      { name: 'UserId', storage: 'text', interpretation: 'plain' },
    ],
    uniqueOn: ['MessageId', 'Emoji', 'UserId'],
    permissions: {
      viewer: { read: true, create: false, update: false, delete: false },
      member: { read: true, create: true, update: false, delete: 'own' },
      admin: { read: true, create: true, update: false, delete: true },
    },
    ownerField: 'UserId',
  },
  {
    name: 'conv_members',
    columns: [
      { name: 'UserId', storage: 'text', interpretation: 'plain' },
      { name: 'UserName', storage: 'text', interpretation: 'plain' },
      { name: 'Role', storage: 'text', interpretation: 'plain' },
    ],
    uniqueOn: ['UserId'],
    permissions: {
      viewer: { read: true, create: false, update: false, delete: false },
      member: { read: true, create: true, update: 'own', delete: false },
      admin: { read: true, create: true, update: true, delete: true },
    },
    ownerField: 'UserId',
  },
  {
    name: 'conv_read_cursors',
    columns: [
      { name: 'UserId', storage: 'text', interpretation: 'plain' },
      { name: 'LastReadAt', storage: 'text', interpretation: 'plain' },
    ],
    uniqueOn: ['UserId'],
    permissions: {
      viewer: { read: true, create: false, update: false, delete: false },
      member: { read: true, create: true, update: 'own', delete: false },
      admin: { read: true, create: true, update: true, delete: true },
    },
    ownerField: 'UserId',
  },
]

/**
 * Voting schemas for Reddit-style apps.
 * Add these alongside CONVERSATION_SCHEMAS for apps that need voting.
 */
export const VOTING_SCHEMAS: CollectionSchema[] = [
  {
    name: 'conv_votes',
    columns: [
      { name: 'TargetId', storage: 'text', interpretation: 'plain' },
      { name: 'UserId', storage: 'text', interpretation: 'plain' },
      { name: 'Direction', storage: 'number', interpretation: 'plain' },
    ],
    uniqueOn: ['TargetId', 'UserId'],
    permissions: {
      viewer: { read: true, create: false, update: false, delete: false },
      member: { read: true, create: true, update: 'own', delete: 'own' },
      admin: { read: true, create: true, update: true, delete: true },
    },
    ownerField: 'UserId',
  },
]
