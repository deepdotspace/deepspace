/**
 * Shared type definitions for the DeepSpace SDK
 *
 * Types used by both client-side SDK and server-side workers.
 */

// ============================================================================
// Schema Types
// ============================================================================

export type ColumnInterpretation =
  | { kind: 'plain' }
  | { kind: 'currency'; symbol: string; decimals: number }
  | { kind: 'date'; format?: string }
  | { kind: 'datetime'; format?: string }
  | { kind: 'boolean'; trueLabel?: string; falseLabel?: string }
  | { kind: 'percent'; decimals?: number }
  | { kind: 'select'; options: string[] }
  | { kind: 'multiselect'; options: string[] }
  | { kind: 'url' }
  | { kind: 'email' }
  | { kind: 'json' }
  | { kind: 'reference'; targetTable: string; displayColumn: string }

export interface ColumnDefinition {
  /** Stable ID override (survives renames). Falls back to `col_{name}`. */
  id?: string
  name: string
  storage: 'number' | 'text'
  interpretation: ColumnInterpretation | string
  expression?: string
  userBound?: boolean
  immutable?: boolean
  required?: boolean
  default?: unknown
  timestampTrigger?: { field: string; value?: unknown }
}

export type PermissionLevel =
  | boolean
  | 'own'
  | 'unclaimed-or-own'
  | 'collaborator'
  | 'team'
  | 'access'
  | 'published'
  | 'shared'

export interface RolePermissions {
  read: PermissionLevel
  /** Create has no existing record to evaluate, so it is an explicit grant. */
  create: boolean
  update: PermissionLevel
  delete: PermissionLevel
  /** If set, only these caller-supplied columns can be created or updated by this role. */
  writableFields?: string[]
}

export interface CollectionSchema {
  name: string
  /** Every collection is stored in typed SQL columns. */
  columns: ColumnDefinition[]
  /** Composite uniqueness constraint (for example `['userId', 'taskId']`). */
  uniqueOn?: string[]
  /** Ownership column; defaults to the row creator. */
  ownerField?: string
  /** Column containing a JSON array of collaborator user ids. */
  collaboratorsField?: string
  /** Column containing the team id used by team permission rules. */
  teamField?: string
  /** A string is public when equal to `public`; an object supplies an exact value. */
  visibilityField?: string | { field: string; value: unknown }
  /** Permissions per role; `*` is the catch-all role. */
  permissions: Record<string, RolePermissions>
  /** Default role assigned on the `users` collection. */
  defaultRole?: string
  /**
   * `users` collection only: what the `user.list` roster shows a non-admin
   * whose `read` policy is row-scoped (`'own'`, `'team'`, …). Default
   * `'public-identity'`: every registered user's id/name/imageUrl/role/lastSeenAt
   * (`lastSeenAt` is what `usePresence` reads) — the
   * row policy keeps guarding full-row reads on the records/query path.
   * `'read-policy'`: the roster contains only the rows the caller's read
   * policy grants (still projected to public identity) — for apps that scope
   * users to a tenant/team and must not show names across it.
   */
  roster?: 'public-identity' | 'read-policy'
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
