/**
 * Workspace DO Schemas
 *
 * All collections for the workspace:default Durable Object.
 * This DO consolidates shared, cross-app business data:
 *
 * - teams / team_members — workspace-wide team management (replaces built-in teams)
 * - tasks / projects / tags — team-scoped task management
 * - people — shared contacts directory
 * - transactions / accounts — shared financial ledger
 *
 * Team-scoped collections use teamField RBAC: members see only
 * their team's records; admins see everything.
 */

import type { CollectionSchema } from './registry'

// ============================================================================
// Teams
// ============================================================================

export const workspaceTeamsSchema: CollectionSchema = {
  name: 'teams',
  columns: [
    { name: 'Name', storage: 'text', interpretation: 'plain' },
    { name: 'CreatedBy', storage: 'text', interpretation: 'plain' },
    { name: 'IsOpen', storage: 'number', interpretation: { kind: 'boolean' } },
  ],
  teamField: '_rowId',
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'team', create: true, update: 'team', delete: 'own' },
  },
}

export const workspaceTeamMembersSchema: CollectionSchema = {
  name: 'team_members',
  columns: [
    { name: 'TeamId', storage: 'text', interpretation: 'plain' },
    { name: 'UserId', storage: 'text', interpretation: 'plain' },
    { name: 'RoleInTeam', storage: 'text', interpretation: { kind: 'select', options: ['admin', 'member'] } },
    { name: 'JoinedAt', storage: 'text', interpretation: { kind: 'datetime' } },
    { name: 'Email', storage: 'text', interpretation: { kind: 'email' } },
    { name: 'Status', storage: 'text', interpretation: { kind: 'select', options: ['active', 'invited'] } },
  ],
  teamField: 'TeamId',
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'team', create: true, update: 'team', delete: 'team' },
  },
}

// ============================================================================
// Tasks / Projects / Tags (team-scoped)
// ============================================================================

export const workspaceTasksSchema: CollectionSchema = {
  name: 'tasks',
  columns: [
    { name: 'TeamId', storage: 'text', interpretation: 'plain' },
    { name: 'Title', storage: 'text', interpretation: 'plain' },
    { name: 'Notes', storage: 'text', interpretation: 'plain' },
    { name: 'Completed', storage: 'number', interpretation: { kind: 'boolean' } },
    { name: 'CompletedAt', storage: 'number', interpretation: 'plain' },
    { name: 'Deleted', storage: 'number', interpretation: { kind: 'boolean' } },
    { name: 'DeletedAt', storage: 'number', interpretation: 'plain' },
    { name: 'Priority', storage: 'text', interpretation: { kind: 'select', options: ['none', 'low', 'medium', 'high'] } },
    { name: 'DueDate', storage: 'text', interpretation: 'plain' },
    { name: 'ProjectId', storage: 'text', interpretation: 'plain' },
    { name: 'KanbanStatus', storage: 'text', interpretation: { kind: 'select', options: ['backlog', 'ready', 'in_progress', 'review', 'done'] } },
    { name: 'Order', storage: 'number', interpretation: 'plain' },
    { name: 'AssignedUser', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'AssignedBy', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'TagIds', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'CreatedAt', storage: 'number', interpretation: 'plain' },
  ],
  teamField: 'TeamId',
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'team', create: true, update: 'team', delete: 'team' },
    viewer: { read: false, create: false, update: false, delete: false },
  },
}

export const workspaceProjectsSchema: CollectionSchema = {
  name: 'projects',
  columns: [
    { name: 'TeamId', storage: 'text', interpretation: 'plain' },
    { name: 'Title', storage: 'text', interpretation: 'plain' },
    { name: 'Notes', storage: 'text', interpretation: 'plain' },
    { name: 'Color', storage: 'text', interpretation: 'plain' },
    { name: 'ParentId', storage: 'text', interpretation: 'plain' },
    { name: 'Order', storage: 'number', interpretation: 'plain' },
    { name: 'CreatedAt', storage: 'number', interpretation: 'plain' },
  ],
  teamField: 'TeamId',
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'team', create: true, update: 'team', delete: 'team' },
    viewer: { read: false, create: false, update: false, delete: false },
  },
}

export const workspaceTagsSchema: CollectionSchema = {
  name: 'tags',
  columns: [
    { name: 'TeamId', storage: 'text', interpretation: 'plain' },
    { name: 'Name', storage: 'text', interpretation: 'plain' },
    { name: 'Color', storage: 'text', interpretation: 'plain' },
    { name: 'CreatedAt', storage: 'number', interpretation: 'plain' },
  ],
  teamField: 'TeamId',
  permissions: {
    admin: { read: true, create: true, update: true, delete: true },
    member: { read: 'team', create: true, update: 'team', delete: 'team' },
    viewer: { read: false, create: false, update: false, delete: false },
  },
}

// ============================================================================
// People (shared contacts directory)
// ============================================================================

export const workspacePeopleSchema: CollectionSchema = {
  name: 'people',
  columns: [
    { name: 'Name', storage: 'text', interpretation: 'plain' },
    { name: 'Email', storage: 'text', interpretation: { kind: 'email' } },
    { name: 'Type', storage: 'text', interpretation: { kind: 'select', options: ['employee', 'customer', 'vendor', 'contact'] } },
    { name: 'Status', storage: 'text', interpretation: { kind: 'select', options: ['active', 'inactive', 'archived'] } },
    { name: 'CompanyId', storage: 'text', interpretation: 'plain' },
    { name: 'Department', storage: 'text', interpretation: 'plain' },
    { name: 'Title', storage: 'text', interpretation: 'plain' },
    { name: 'LastContactedAt', storage: 'text', interpretation: { kind: 'datetime' } },
    { name: 'Metadata', storage: 'text', interpretation: { kind: 'json' } },
  ],
  permissions: {
    '*': { read: true, create: true, update: true, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

// ============================================================================
// Ledger (shared financial data)
// ============================================================================

export const workspaceTransactionsSchema: CollectionSchema = {
  name: 'transactions',
  columns: [
    { name: 'Type', storage: 'text', interpretation: { kind: 'select', options: ['revenue', 'expense', 'payment', 'transfer', 'invoice', 'refund'] } },
    { name: 'Amount', storage: 'number', interpretation: { kind: 'currency', symbol: '$', decimals: 2 } },
    { name: 'Currency', storage: 'text', interpretation: 'plain' },
    { name: 'Description', storage: 'text', interpretation: 'plain' },
    { name: 'Category', storage: 'text', interpretation: 'plain' },
    { name: 'CounterpartyRef', storage: 'text', interpretation: 'plain' },
    { name: 'OrderRef', storage: 'text', interpretation: 'plain' },
    { name: 'Account', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    '*': { read: true, create: true, update: true, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

export const workspaceAccountsSchema: CollectionSchema = {
  name: 'accounts',
  columns: [
    { name: 'Name', storage: 'text', interpretation: 'plain' },
    { name: 'Balance', storage: 'number', interpretation: { kind: 'currency', symbol: '$', decimals: 2 } },
    { name: 'Currency', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    '*': { read: true, create: true, update: true, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

// ============================================================================
// Content Sharing (universal cross-app content discovery)
// ============================================================================

/**
 * Universal sharing index. Any app can create share records for any content type.
 *
 * ContentType: 'document' | 'slide' | 'spreadsheet' | ... (extensible)
 * ShareType:   'channel' | 'team' | 'direct' | 'link' | 'org' (extensible)
 * ShareTarget: the ID of the target (channelId, teamId, userId, linkId, orgId)
 * Permission:  'view' | 'edit' — what the share grants
 *
 * Content itself lives in the owner's app DO.
 * This table is the discovery layer: "what has been shared, with whom, and how".
 */
export const workspaceContentSharesSchema: CollectionSchema = {
  name: 'content_shares',
  ownerField: 'OwnerId',
  columns: [
    { name: 'ContentType', storage: 'text', interpretation: { kind: 'select', options: ['document', 'slide', 'spreadsheet'] } },
    { name: 'ContentId', storage: 'text', interpretation: 'plain' },
    { name: 'OwnerId', storage: 'text', interpretation: 'plain' },
    { name: 'OwnerName', storage: 'text', interpretation: 'plain' },
    { name: 'Title', storage: 'text', interpretation: 'plain' },
    { name: 'ShareType', storage: 'text', interpretation: { kind: 'select', options: ['self', 'channel', 'team', 'direct', 'link', 'org'] } },
    { name: 'ShareTarget', storage: 'text', interpretation: 'plain' },
    { name: 'Permission', storage: 'text', interpretation: { kind: 'select', options: ['view', 'edit'] } },
    { name: 'SharedAt', storage: 'text', interpretation: { kind: 'datetime' } },
    { name: 'SharedBy', storage: 'text', interpretation: 'plain' },
    { name: 'SourceApp', storage: 'text', interpretation: 'plain' },
    { name: 'WordCount', storage: 'number', interpretation: 'plain' },
    { name: 'LastEditedAt', storage: 'text', interpretation: { kind: 'datetime' } },
  ],
  permissions: {
    '*': { read: true, create: true, update: true, delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

// ============================================================================
// Form Responses (cross-app: deepspace-forms → sheets-editor)
// ============================================================================

export const workspaceFormResponsesSchema: CollectionSchema = {
  name: 'form_responses',
  columns: [
    { name: 'FormId', storage: 'text', interpretation: 'plain' },
    { name: 'FormTitle', storage: 'text', interpretation: 'plain' },
    { name: 'RespondentId', storage: 'text', interpretation: 'plain' },
    { name: 'RespondentEmail', storage: 'text', interpretation: { kind: 'email' } },
    { name: 'RespondentName', storage: 'text', interpretation: 'plain' },
    { name: 'Data', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'SubmittedAt', storage: 'text', interpretation: { kind: 'datetime' } },
  ],
  permissions: {
    '*': { read: true, create: true, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

// ============================================================================
// Email Handles (cross-app user identity)
// ============================================================================

/**
 * Maps DeepSpace users to their claimed @app.space email handles.
 * Shared across all apps so any app can look up a user's email address.
 * All handles are under the @app.space domain.
 */
export const workspaceEmailHandlesSchema: CollectionSchema = {
  name: 'email_handles',
  columns: [
    { name: 'UserId', storage: 'text', interpretation: 'plain' },
    { name: 'Handle', storage: 'text', interpretation: 'plain' },
    { name: 'EmailAddress', storage: 'text', interpretation: { kind: 'email' } },
    { name: 'Status', storage: 'text', interpretation: { kind: 'select', options: ['active', 'disabled'] } },
  ],
  uniqueOn: ['Handle'],
  ownerField: 'UserId',
  permissions: {
    '*': { read: true, create: true, update: 'own', delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

// ============================================================================
// Export
// ============================================================================

export const WORKSPACE_SCHEMAS: CollectionSchema[] = [
  workspaceTeamsSchema,
  workspaceTeamMembersSchema,
  workspaceTasksSchema,
  workspaceProjectsSchema,
  workspaceTagsSchema,
  workspacePeopleSchema,
  workspaceTransactionsSchema,
  workspaceAccountsSchema,
  workspaceContentSharesSchema,
  workspaceFormResponsesSchema,
  workspaceEmailHandlesSchema,
]
