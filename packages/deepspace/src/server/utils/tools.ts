/**
 * Tools API Types and Definitions
 * 
 * MCP-like interface for agent tool calls.
 * Built-in tools for storage and backup operations.
 */

export interface ToolSchema {
  name: string
  description: string
  params: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array'
    description: string
    required?: boolean
    default?: unknown
  }>
}

/**
 * Discriminated union so callers don't have to guard on `error` being
 * defined when `success` is false — TS enforces the invariant.
 */
export type ToolResult =
  | { success: true; data?: unknown }
  | { success: false; error: string }

/**
 * Page size the assistant defaults to for `records.query` when it omits
 * `limit`. Keeps a model-issued unbounded scan from blowing the tool-result
 * byte cap and gives the model a usable first page. Raise `limit` to page
 * through more (still subject to the cap; see
 * `DEFAULT_CONTEXT_CONFIG.toolResultCap` / `capToolResultSize`, which truncates
 * oversized pages gracefully rather than dropping them).
 *
 * Applied by the AI tool layer via `applyAiToolDefaults`, never by the shared
 * tools-api dispatch, so internal record readers (chat history, cron, app
 * `actions.query`) stay unbounded.
 */
export const DEFAULT_QUERY_LIMIT = 50

/**
 * Fill in assistant-only parameter defaults for a built-in tool call.
 *
 * Applied by the AI tool layer (`buildTools`) before a model-issued tool call
 * is dispatched, so the default only affects calls the assistant makes.
 * `records.query` doubles as the SDK's general record-read primitive (chat
 * history, cron, app `actions.query`); those callers reach the tools dispatch
 * directly and must return every row, so this default must not live in the
 * dispatch itself. Pure and non-mutating.
 */
export function applyAiToolDefaults(
  toolName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === 'records.query' && params.limit === undefined) {
    return { ...params, limit: DEFAULT_QUERY_LIMIT }
  }
  return params
}

/**
 * Built-in tool definitions for storage, record, schema, user, and backup operations
 */
export const BUILT_IN_TOOLS: ToolSchema[] = [
  // Record tools (structured collections with RBAC)
  {
    name: 'records.query',
    description:
      'Query records from a collection with optional filtering, ordering, and pagination. ' +
      `Returns at most \`limit\` records (default ${DEFAULT_QUERY_LIMIT}). Large result sets are capped at ~30KB: ` +
      'an oversized page is truncated to the leading records that fit and flagged with ' +
      '`{ truncated, returned, total }`, so narrow with a `where` filter (or page via `orderBy` + `limit`) ' +
      'to see the rest.',
    params: {
      collection: { type: 'string', description: 'Collection name to query', required: true },
      where: { type: 'object', description: 'Filter object with field=value equality conditions', required: false },
      orderBy: { type: 'string', description: 'Field to order by (or "createdAt"/"updatedAt")', required: false },
      orderDir: { type: 'string', description: 'Order direction: "asc" or "desc" (default: "desc")', required: false },
      limit: { type: 'number', description: `Maximum number of records to return (default: ${DEFAULT_QUERY_LIMIT}). Oversized pages are still capped at ~30KB and truncated with returned/total flags.`, required: false },
    }
  },
  {
    name: 'records.get',
    description: 'Get a single record by ID from a collection',
    params: {
      collection: { type: 'string', description: 'Collection name', required: true },
      recordId: { type: 'string', description: 'Record ID to retrieve', required: true },
    }
  },
  {
    name: 'records.create',
    description: 'Create a new record in a collection',
    params: {
      collection: { type: 'string', description: 'Collection name', required: true },
      data: { type: 'object', description: 'Record data matching the collection schema', required: true },
      recordId: { type: 'string', description: 'Custom record ID (auto-generated if omitted)', required: false },
    }
  },
  {
    name: 'records.update',
    description: 'Update an existing record in a collection',
    params: {
      collection: { type: 'string', description: 'Collection name', required: true },
      recordId: { type: 'string', description: 'Record ID to update', required: true },
      data: { type: 'object', description: 'Fields to update (merged with existing data)', required: true },
    }
  },
  {
    name: 'records.delete',
    description: 'Delete a record from a collection',
    params: {
      collection: { type: 'string', description: 'Collection name', required: true },
      recordId: { type: 'string', description: 'Record ID to delete', required: true },
    }
  },
  // Schema tools
  {
    name: 'schema.list',
    description: 'List all registered collection schemas with their fields and permissions',
    params: {}
  },
  {
    name: 'schema.describe',
    description: 'Get the full schema for a specific collection including field types and role permissions',
    params: {
      collection: { type: 'string', description: 'Collection name to describe', required: true },
    }
  },
  // User tools
  {
    name: 'user.current',
    description: 'Get the current user\'s profile (ID, name, email, role)',
    params: {}
  },
  {
    name: 'user.list',
    description: 'List all users in this room',
    params: {}
  },
  // Storage tools (legacy key-value)
  {
    name: 'storage.list',
    description: 'List all keys in a storage scope',
    params: {
      scope: { type: 'string', description: 'Storage scope: global, files, user, userFiles', required: true },
      prefix: { type: 'string', description: 'Optional key prefix filter', required: false },
      userId: { type: 'string', description: 'User ID (required for user/userFiles scopes)', required: false },
    }
  },
  {
    name: 'storage.read',
    description: 'Read one or more keys from storage',
    params: {
      scope: { type: 'string', description: 'Storage scope: global, files, user, userFiles', required: true },
      keys: { type: 'array', description: 'Array of keys to read (or single key string)', required: true },
      userId: { type: 'string', description: 'User ID (required for user/userFiles scopes)', required: false },
    }
  },
  {
    name: 'storage.write',
    description: 'Write one or more key-value pairs to storage (batch supported)',
    params: {
      scope: { type: 'string', description: 'Storage scope: global, files, user, userFiles', required: true },
      data: { type: 'object', description: 'Object with key-value pairs to write', required: true },
      userId: { type: 'string', description: 'User ID (required for user/userFiles scopes)', required: false },
    }
  },
  {
    name: 'storage.delete',
    description: 'Delete one or more keys from storage',
    params: {
      scope: { type: 'string', description: 'Storage scope: global, files, user, userFiles', required: true },
      keys: { type: 'array', description: 'Array of keys to delete', required: true },
      userId: { type: 'string', description: 'User ID (required for user/userFiles scopes)', required: false },
    }
  },
  // Backup tools
  {
    name: 'backup.create',
    description: 'Create a backup of the current Yjs document state to R2',
    params: {
      description: { type: 'string', description: 'Optional description for the backup', required: false },
    }
  },
  {
    name: 'backup.list',
    description: 'List all available backups',
    params: {
      limit: { type: 'number', description: 'Maximum number of backups to return (default: 50)', required: false },
    }
  },
  {
    name: 'backup.restore',
    description: 'Restore the Yjs document from a backup',
    params: {
      backupId: { type: 'string', description: 'The backup ID to restore from', required: true },
    }
  },
  {
    name: 'backup.delete',
    description: 'Delete a specific backup',
    params: {
      backupId: { type: 'string', description: 'The backup ID to delete', required: true },
    }
  },
  // Yjs tools (collaborative document access)
  {
    name: 'yjs.list',
    description: 'List all Yjs documents stored in this room, showing collection, recordId, fieldName, and last update time',
    params: {}
  },
  {
    name: 'yjs.getText',
    description: 'Read text content from a Yjs document (for fields using useYjsText)',
    params: {
      collection: { type: 'string', description: 'Collection name', required: true },
      recordId: { type: 'string', description: 'Record ID', required: true },
      fieldName: { type: 'string', description: 'Field name (e.g., "content")', required: true },
    }
  },
  {
    name: 'yjs.setText',
    description: 'Write text content to a Yjs document (replaces existing text, broadcasts to connected clients)',
    params: {
      collection: { type: 'string', description: 'Collection name', required: true },
      recordId: { type: 'string', description: 'Record ID', required: true },
      fieldName: { type: 'string', description: 'Field name (e.g., "content")', required: true },
      text: { type: 'string', description: 'The text content to set', required: true },
    }
  },
]

