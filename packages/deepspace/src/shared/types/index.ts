/**
 * Shared type definitions for the DeepSpace SDK
 *
 * Types used by both client-side SDK and server-side workers.
 */

// ============================================================================
// Schema Types
// ============================================================================

export type PermissionRule = boolean | 'own' | 'unclaimed-or-own' | 'collaborator' | 'team' | 'access' | 'published' | 'shared'

export interface SchemaPermissions {
  read: PermissionRule
  create: PermissionRule
  update: PermissionRule
  delete: PermissionRule
  writableFields?: string[]
}

export interface CollectionSchema {
  name: string
  columns: Array<{
    name: string
    storage: string
    interpretation: string | Record<string, unknown>
    id?: string
    expression?: string
    userBound?: boolean
    immutable?: boolean
    required?: boolean
    default?: unknown
    timestampTrigger?: { field: string; value?: unknown }
  }>
  uniqueOn?: string[]
  permissions: Record<string, SchemaPermissions>
  ownerField?: string
  collaboratorsField?: string
  teamField?: string
  visibilityField?: string | { field: string; value: unknown }
  defaultRole?: string
}

// ============================================================================
// Query Types
// ============================================================================

export interface Query {
  collection: string
  where?: Record<string, unknown>
  orderBy?: string
  orderDir?: 'asc' | 'desc'
  limit?: number
}

export interface Subscription {
  id: string
  query: Query
}

// ============================================================================
// Yjs Types
// ============================================================================

/** Key for Yjs doc: collection:recordId:fieldName */
export type YjsDocKey = string

export interface YjsSubscription {
  collection: string
  recordId: string
  fieldName: string
}

// NOTE: `ConnectionAttachment` and `HandlerContext` are defined in
// `../protocol/types.ts` (they depend on CF Workers / Yjs imports). Import
// them from `@/shared/protocol/types` rather than from here.

// ============================================================================
// Record Types
// ============================================================================

export interface RecordRow {
  collection: string
  record_id: string
  data: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface RecordResult {
  recordId: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ============================================================================
// Message Payload Types
// ============================================================================

export interface SubscribePayload {
  subscriptionId: string
  query: Query
}

export interface UnsubscribePayload {
  subscriptionId: string
}

export interface PutPayload {
  collection: string
  recordId: string
  data: Record<string, unknown>
  requestId?: string
}

export interface DeletePayload {
  collection: string
  recordId: string
  requestId?: string
}

export interface SetRolePayload {
  userId: string
  role: string
}

export interface YjsJoinPayload {
  collection: string
  recordId: string
  fieldName: string
}

export interface YjsLeavePayload {
  collection: string
  recordId: string
  fieldName: string
}

// ============================================================================
// Cron Types
// ============================================================================

export interface CronTask {
  name: string
  intervalMinutes?: number
  schedule?: string
  timezone?: string
  lastRun: number
}

export interface CronConfig {
  ownerUserId: string
  tasks: CronTask[]
}

// ============================================================================
// Directory Data Interfaces (dir:{appName} scope)
// ============================================================================

export interface DirectoryConversationData {
  Name: string
  Description: string
  Type: string
  Visibility: string
  CreatedBy: string
  ParticipantHash: string
  ParticipantIds: string
  Status: string
  AssigneeId: string
  LinkedRef: string
  LastMessageAt: string
  LastMessagePreview: string
  LastMessageAuthor: string
  MessageCount: number
}

export interface ConversationStateData {
  ConversationId: string
  UserId: string
  LastReadAt: string
  LastReadMessageCount: number
  Starred: number
  Archived: number
  Trashed: number
  Labels: string
  Folder: string
}

export interface DirectoryCommunityData {
  Name: string
  Description: string
  CreatedBy: string
  Type: string
  Visibility: string
  MemberCount: number
  Rules: string
  IconUrl: string
  CoverUrl: string
}

export interface DirectoryMembershipData {
  CommunityId: string
  UserId: string
  UserName: string
  Role: string
  JoinedAt: string
}

export interface DirectoryPostData {
  Title: string
  Content: string
  AuthorId: string
  Type: string
  CommunityId: string
  ParentId: string
  ConversationId: string
  Status: string
  Tags: string
  LinkUrl: string
}

// ============================================================================
// Conversation Data Interfaces (conv:{id} scope)
// ============================================================================

export interface ConvMessageData {
  Content: string
  AuthorId: string
  ParentId: string
  Edited: number
  MessageType: string
  Metadata: string
}

export interface ConvReactionData {
  MessageId: string
  Emoji: string
  UserId: string
}

export interface ConvMemberData {
  UserId: string
  UserName: string
  Role: string
}

export interface ConvReadCursorData {
  UserId: string
  LastReadAt: string
}

export interface ConvVoteData {
  TargetId: string
  UserId: string
  Direction: number
}
