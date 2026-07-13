/**
 * Directory DO Schemas
 *
 * Purpose-built collections for the `dir:{appName}` global DO type.
 * This is the cross-app-visible directory layer — any app can subscribe
 * to another app's directory in real-time via SHARED_CONNECTIONS.
 *
 * Five collections covering all standard communication/social patterns:
 * - conversations: channels, DMs, email threads, support chats
 * - conversation_state: per-user metadata (read cursor, stars, labels, folders)
 * - communities: groups, forums, boards, projects
 * - memberships: user membership in communities
 * - posts: feed items, tweets, Q&A questions, announcements
 *
 * Domain-specific data (tickets, CRM, procurement) stays in app DOs.
 * Message content stays in conv:{id} DOs (CONVERSATION_SCHEMAS).
 */

import type { CollectionSchema } from './registry'

// Re-export data interfaces from types (single source of truth)
export type {
  DirectoryConversationData,
  ConversationStateData,
  DirectoryCommunityData,
  DirectoryMembershipData,
  DirectoryPostData,
} from '../../shared/types'

// ============================================================================
// Schemas
// ============================================================================

const conversationsSchema: CollectionSchema = {
  name: 'conversations',
  columns: [
    { name: 'Name', storage: 'text', interpretation: 'plain' },
    { name: 'Description', storage: 'text', interpretation: 'plain' },
    { name: 'Type', storage: 'text', interpretation: { kind: 'select', options: ['public', 'private', 'dm', 'group', 'email', 'outbound-email', 'support', 'announcement'] } },
    { name: 'Visibility', storage: 'text', interpretation: { kind: 'select', options: ['public', 'private', 'restricted'] } },
    { name: 'CreatedBy', storage: 'text', interpretation: 'plain' },
    { name: 'ParticipantHash', storage: 'text', interpretation: 'plain' },
    { name: 'ParticipantIds', storage: 'text', interpretation: 'json' },
    { name: 'Status', storage: 'text', interpretation: { kind: 'select', options: ['active', 'archived', 'resolved', 'closed'] } },
    { name: 'AssigneeId', storage: 'text', interpretation: 'plain' },
    { name: 'LinkedRef', storage: 'text', interpretation: 'json' },
    { name: 'LastMessageAt', storage: 'text', interpretation: { kind: 'datetime' } },
    { name: 'LastMessagePreview', storage: 'text', interpretation: 'plain' },
    { name: 'LastMessageAuthor', storage: 'text', interpretation: 'plain' },
    { name: 'MessageCount', storage: 'number', interpretation: 'plain' },
  ],
  collaboratorsField: 'ParticipantIds',
  visibilityField: 'Visibility',
  permissions: {
    viewer: { read: 'shared', create: false, update: false, delete: false },
    member: { read: 'shared', create: true, update: true, delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
  ownerField: 'CreatedBy',
}

const conversationStateSchema: CollectionSchema = {
  name: 'conversation_state',
  columns: [
    { name: 'ConversationId', storage: 'text', interpretation: 'plain' },
    { name: 'UserId', storage: 'text', interpretation: 'plain' },
    { name: 'LastReadAt', storage: 'text', interpretation: { kind: 'datetime' } },
    { name: 'LastReadMessageCount', storage: 'number', interpretation: 'plain' },
    { name: 'Starred', storage: 'number', interpretation: 'boolean' },
    { name: 'Archived', storage: 'number', interpretation: 'boolean' },
    { name: 'Trashed', storage: 'number', interpretation: 'boolean' },
    { name: 'Labels', storage: 'text', interpretation: 'json' },
    { name: 'Folder', storage: 'text', interpretation: 'plain' },
  ],
  uniqueOn: ['ConversationId', 'UserId'],
  ownerField: 'UserId',
  permissions: {
    viewer: { read: false, create: false, update: false, delete: false },
    member: { read: 'own', create: true, update: 'own', delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

const communitiesSchema: CollectionSchema = {
  name: 'communities',
  columns: [
    { name: 'Name', storage: 'text', interpretation: 'plain' },
    { name: 'Description', storage: 'text', interpretation: 'plain' },
    { name: 'CreatedBy', storage: 'text', interpretation: 'plain' },
    { name: 'Type', storage: 'text', interpretation: { kind: 'select', options: ['community', 'forum', 'board', 'project', 'server'] } },
    { name: 'Visibility', storage: 'text', interpretation: { kind: 'select', options: ['public', 'private', 'restricted'] } },
    { name: 'MemberCount', storage: 'number', interpretation: 'plain' },
    { name: 'Rules', storage: 'text', interpretation: 'json' },
    { name: 'IconUrl', storage: 'text', interpretation: 'plain' },
    { name: 'CoverUrl', storage: 'text', interpretation: 'plain' },
  ],
  uniqueOn: ['Name'],
  permissions: {
    viewer: { read: true, create: false, update: false, delete: false },
    member: { read: true, create: true, update: 'own', delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
  ownerField: 'CreatedBy',
}

const membershipsSchema: CollectionSchema = {
  name: 'memberships',
  columns: [
    { name: 'CommunityId', storage: 'text', interpretation: 'plain' },
    { name: 'UserId', storage: 'text', interpretation: 'plain' },
    { name: 'UserName', storage: 'text', interpretation: 'plain' },
    { name: 'Role', storage: 'text', interpretation: { kind: 'select', options: ['member', 'moderator', 'admin'] } },
    { name: 'JoinedAt', storage: 'text', interpretation: { kind: 'datetime' } },
  ],
  uniqueOn: ['CommunityId', 'UserId'],
  permissions: {
    viewer: { read: true, create: false, update: false, delete: false },
    member: { read: true, create: true, update: 'own', delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
  ownerField: 'UserId',
}

const postsSchema: CollectionSchema = {
  name: 'posts',
  columns: [
    { name: 'Title', storage: 'text', interpretation: 'plain' },
    { name: 'Content', storage: 'text', interpretation: 'plain' },
    { name: 'AuthorId', storage: 'text', interpretation: 'plain' },
    { name: 'Type', storage: 'text', interpretation: { kind: 'select', options: ['post', 'question', 'answer', 'tweet', 'announcement', 'link'] } },
    { name: 'CommunityId', storage: 'text', interpretation: 'plain' },
    { name: 'ParentId', storage: 'text', interpretation: 'plain' },
    { name: 'ConversationId', storage: 'text', interpretation: 'plain' },
    { name: 'Status', storage: 'text', interpretation: { kind: 'select', options: ['draft', 'published', 'pinned', 'archived', 'accepted'] } },
    { name: 'Tags', storage: 'text', interpretation: 'json' },
    { name: 'LinkUrl', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    viewer: { read: true, create: false, update: false, delete: false },
    member: { read: true, create: true, update: 'own', delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
  ownerField: 'AuthorId',
}

// ============================================================================
// Exports
// ============================================================================

/** All directory schemas for the `dir:{appName}` global DO type. */
export const DIRECTORY_SCHEMAS: CollectionSchema[] = [
  conversationsSchema,
  conversationStateSchema,
  communitiesSchema,
  membershipsSchema,
  postsSchema,
]
