/**
 * Collection Schema Definitions & Validation
 *
 * All collections use typed SQL columns. No document-mode / fields-based storage.
 */

// ============================================================================
// Column Definitions
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
  /** Auto-populate with current user ID on create. */
  userBound?: boolean
  /** Cannot be changed after initial creation. */
  immutable?: boolean
  /** Must be provided on create (non-null). */
  required?: boolean
  /** Default value if not provided on create. */
  default?: unknown
  /** Auto-set ISO timestamp when the named field changes (optionally to a specific value). */
  timestampTrigger?: { field: string; value?: unknown }
}

export interface ResolvedColumn {
  id: string
  name: string
  storage: 'number' | 'text'
  interpretation: ColumnInterpretation
  expression?: string
  readonly: boolean
  userBound?: boolean
  immutable?: boolean
  required?: boolean
  default?: unknown
  timestampTrigger?: { field: string; value?: unknown }
}

// ============================================================================
// Column Helpers
// ============================================================================

export function collectionTableName(name: string): string {
  return `c_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

export function columnId(name: string): string {
  return `col_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
}

export function resolveColumn(col: ColumnDefinition): ResolvedColumn {
  const interp: ColumnInterpretation =
    typeof col.interpretation === 'string'
      ? ({ kind: col.interpretation } as ColumnInterpretation)
      : col.interpretation
  return {
    id: col.id ?? columnId(col.name),
    name: col.name,
    storage: col.storage,
    interpretation: interp,
    expression: col.expression,
    readonly: !!col.expression,
    userBound: col.userBound,
    immutable: col.immutable,
    required: col.required,
    default: col.default,
    timestampTrigger: col.timestampTrigger,
  }
}

export function rowToData(
  row: Record<string, unknown>,
  columns: ResolvedColumn[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const col of columns) {
    if (row[col.id] !== undefined && row[col.id] !== null) {
      let val = row[col.id]
      if (col.interpretation.kind === 'json' && typeof val === 'string') {
        try {
          val = JSON.parse(val as string)
        } catch {
          /* keep as string */
        }
      }
      data[col.name] = val
    }
  }
  return data
}

export function dataToColumnValues(
  data: Record<string, unknown>,
  columns: ResolvedColumn[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const col of columns) {
    if (col.expression || col.readonly) continue
    const val = data[col.id] ?? data[col.name]
    if (val !== undefined) {
      values[col.id] = coerceValue(val, col.storage, col.interpretation)
    }
  }
  return values
}

export function coerceValue(
  value: unknown,
  storage: 'number' | 'text',
  interpretation: ColumnInterpretation,
): unknown {
  if (value === null || value === undefined || value === '') return null

  if (storage === 'text') {
    if (interpretation.kind === 'json') {
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch {
        return null
      }
    }
    return typeof value === 'string' ? value : String(value)
  }

  if (typeof value === 'number') return isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'string') return String(value)

  const s = value.trim()

  if (interpretation.kind === 'boolean') {
    const lower = s.toLowerCase()
    if (lower === 'true' || lower === '1' || lower === 'yes') return 1
    if (lower === 'false' || lower === '0' || lower === 'no') return 0
    return s
  }

  if (interpretation.kind === 'percent') {
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*%$/)
    if (m) return parseFloat(m[1]) / 100
  }

  if (interpretation.kind === 'currency') {
    const cleaned = s.replace(/[^0-9.-]/g, '')
    const n = parseFloat(cleaned)
    if (!isNaN(n)) return n
    return s
  }

  if (interpretation.kind === 'date' || interpretation.kind === 'datetime') {
    const d = new Date(s)
    if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000)
    return s
  }

  const cleaned = s.replace(/[$€£¥,\s]/g, '')
  const n = parseFloat(cleaned)
  if (!isNaN(n) && isFinite(n)) return n

  return s
}

export function buildTableSelect(collectionName: string, columns: ResolvedColumn[]): string {
  const tbl = collectionTableName(collectionName)
  const parts: string[] = ['_row_id', '_created_by', '_created_at', '_updated_at']
  for (const col of columns) {
    if (col.expression) {
      parts.push(`(${col.expression}) AS "${col.id}"`)
    } else {
      parts.push(`"${col.id}"`)
    }
  }
  return `SELECT ${parts.join(', ')} FROM "${tbl}"`
}

// ============================================================================
// Permissions
// ============================================================================

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
  create: boolean
  update: PermissionLevel
  delete: PermissionLevel
  /** If set, only these columns can be updated by this role. */
  writableFields?: string[]
}

// ============================================================================
// Collection Schema
// ============================================================================

export interface CollectionSchema {
  name: string
  /** Column definitions — every collection is stored in a typed SQL table. */
  columns: ColumnDefinition[]
  /** Composite uniqueness constraint (e.g., ['userId', 'taskId']). */
  uniqueOn?: string[]
  /** Column name used for ownership checks (default: `_created_by`). */
  ownerField?: string
  /** Column containing JSON array of collaborator user IDs. */
  collaboratorsField?: string
  /** Column containing team ID for team-based access. */
  teamField?: string
  /**
   * Column controlling per-record read visibility.
   * String: visible when `data[field] === 'public'`.
   * Object: visible when `data[field] === value`.
   */
  visibilityField?: string | { field: string; value: unknown }
  /** Permissions per role. Use '*' for a catch-all fallback. */
  permissions: Record<string, RolePermissions>
  /** Default role for new users (only on 'users' collection). */
  defaultRole?: string
}

export interface User {
  id: string
  email: string
  name: string
  imageUrl?: string
  role: string
  createdAt: string
  lastSeenAt: string
}

export interface StoredRecord {
  collection: string
  recordId: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ============================================================================
// Permission Checking
// ============================================================================

export interface PermissionContext {
  isTeamMember: (teamId: string, userId: string) => boolean
}

export const noopPermissionContext: PermissionContext = {
  isTeamMember: () => false,
}

export function getRolePermissions(schema: CollectionSchema, role: string): RolePermissions {
  if (schema.permissions[role]) return schema.permissions[role]
  if (schema.permissions['*']) return schema.permissions['*']
  return { read: false, create: false, update: false, delete: false }
}

export function isOwner(
  schema: CollectionSchema,
  record: { data: Record<string, unknown>; createdBy: string },
  userId: string,
): boolean {
  if (schema.ownerField) return record.data[schema.ownerField] === userId
  return record.createdBy === userId
}

function isCollaborator(
  schema: CollectionSchema,
  record: { data: Record<string, unknown> },
  userId: string,
): boolean {
  if (!schema.collaboratorsField) return false
  const collab = record.data[schema.collaboratorsField]
  if (typeof collab === 'string') {
    try {
      return (JSON.parse(collab) as string[]).includes(userId)
    } catch {
      return false
    }
  }
  if (Array.isArray(collab)) return collab.includes(userId)
  return false
}

function passesVisibilityCheck(
  schema: CollectionSchema,
  record: { data: Record<string, unknown> },
): boolean {
  if (!schema.visibilityField) return false
  if (typeof schema.visibilityField === 'string') {
    return record.data[schema.visibilityField] === 'public'
  }
  return record.data[schema.visibilityField.field] === schema.visibilityField.value
}

function checkPermissionLevel(
  level: PermissionLevel,
  schema: CollectionSchema,
  record: { data: Record<string, unknown>; createdBy: string; recordId?: string },
  userId: string,
  ctx: PermissionContext = noopPermissionContext,
): boolean {
  if (level === true) return true
  if (level === false) return false
  if (level === 'own') return isOwner(schema, record, userId)
  if (level === 'unclaimed-or-own') {
    if (schema.ownerField) {
      const ownerVal = record.data[schema.ownerField]
      if (!ownerVal || ownerVal === '') return true
    }
    return isOwner(schema, record, userId)
  }
  if (level === 'collaborator') {
    return isOwner(schema, record, userId) || isCollaborator(schema, record, userId)
  }
  if (level === 'team' || level === 'access') {
    if (isOwner(schema, record, userId)) return true
    if (isCollaborator(schema, record, userId)) return true
    if (schema.teamField) {
      const teamId = record.data[schema.teamField]
      if (typeof teamId === 'string' && ctx.isTeamMember(teamId, userId)) return true
    }
    return false
  }
  if (level === 'published') {
    return isOwner(schema, record, userId) || passesVisibilityCheck(schema, record)
  }
  if (level === 'shared') {
    return (
      isOwner(schema, record, userId) ||
      isCollaborator(schema, record, userId) ||
      passesVisibilityCheck(schema, record)
    )
  }
  return false
}

export function canRead(
  schema: CollectionSchema,
  role: string,
  record: { data: Record<string, unknown>; createdBy: string; recordId?: string },
  userId: string,
  ctx: PermissionContext = noopPermissionContext,
): boolean {
  return checkPermissionLevel(getRolePermissions(schema, role).read, schema, record, userId, ctx)
}

export function canCreate(schema: CollectionSchema, role: string): boolean {
  return getRolePermissions(schema, role).create === true
}

export function canUpdate(
  schema: CollectionSchema,
  role: string,
  record: { data: Record<string, unknown>; createdBy: string; recordId?: string },
  userId: string,
  ctx: PermissionContext = noopPermissionContext,
): boolean {
  return checkPermissionLevel(getRolePermissions(schema, role).update, schema, record, userId, ctx)
}

export function canDelete(
  schema: CollectionSchema,
  role: string,
  record: { data: Record<string, unknown>; createdBy: string; recordId?: string },
  userId: string,
  ctx: PermissionContext = noopPermissionContext,
): boolean {
  return checkPermissionLevel(getRolePermissions(schema, role).delete, schema, record, userId, ctx)
}

/** Check if a field update violates writableFields restrictions. */
export function checkFieldPermissions(
  schema: CollectionSchema,
  role: string,
  newData: Record<string, unknown>,
  existingData?: Record<string, unknown>,
): string | null {
  const perms = getRolePermissions(schema, role)
  if (!perms.writableFields) return null // no restrictions

  const allowedFields = new Set(perms.writableFields)
  for (const key of Object.keys(newData)) {
    if (existingData && newData[key] === existingData[key]) continue
    if (!allowedFields.has(key)) {
      return `Role '${role}' cannot modify field '${key}'`
    }
  }
  return null
}

// ============================================================================
// System-Managed Columns (users collection)
// ============================================================================

/** Names of columns managed by the system (registerUser), not client mutations. */
export const SYSTEM_MANAGED_COLUMNS = new Set([
  'email',
  'name',
  'imageUrl',
  'role',
  'createdAt',
  'lastSeenAt',
])

/** Standard user columns. Apps spread these into their users schema. */
export const USERS_COLUMNS: ColumnDefinition[] = [
  { name: 'email', storage: 'text', interpretation: 'plain' },
  { name: 'name', storage: 'text', interpretation: 'plain' },
  { name: 'imageUrl', storage: 'text', interpretation: 'plain' },
  { name: 'role', storage: 'text', interpretation: 'plain' },
  { name: 'createdAt', storage: 'text', interpretation: { kind: 'datetime' } },
  { name: 'lastSeenAt', storage: 'text', interpretation: { kind: 'datetime' } },
]

export const BASE_USERS_SCHEMA: CollectionSchema = {
  name: 'users',
  columns: [...USERS_COLUMNS],
  permissions: {
    '*': { read: 'own', create: false, update: false, delete: false },
    admin: { read: true, create: false, update: true, delete: true },
  },
}

// ============================================================================
// Schema Registry
// ============================================================================

/**
 * Lint a CollectionSchema for declarations that look like they should
 * enforce something but don't, due to interactions between top-level
 * fields (visibilityField, ownerField) and per-role permission levels.
 *
 * The SDK has historically silently accepted schemas that imply more
 * enforcement than they actually deliver — e.g., `visibilityField` set
 * but every role's `read: true` means "anyone can read everything"
 * regardless of `visibility`. Warn loudly at registration so app
 * authors notice before shipping a privacy bug.
 *
 * Returns an array of warning messages. Empty = clean.
 */
export function lintSchema(schema: CollectionSchema): string[] {
  const warnings: string[] = []
  const VISIBILITY_AWARE: ReadonlyArray<PermissionLevel> = ['published', 'shared']

  // Roles that grant unconditional read despite visibilityField being declared.
  if (schema.visibilityField) {
    const offendingRoles = Object.entries(schema.permissions)
      .filter(([, perms]) => perms.read === true)
      .map(([role]) => role)
    if (offendingRoles.length > 0) {
      const usesAware = Object.values(schema.permissions).some(
        (p) => typeof p.read === 'string' && VISIBILITY_AWARE.includes(p.read as PermissionLevel),
      )
      if (!usesAware) {
        warnings.push(
          `[${schema.name}] visibilityField is declared but no role uses read: 'published' or 'shared'. ` +
            `Roles with read: true (${offendingRoles.join(', ')}) will see every row regardless of visibility. ` +
            `Change those to read: 'published' (owner OR public) or 'shared' (owner OR collaborator OR public) ` +
            `to actually enforce the filter, or remove visibilityField if you don't intend to gate reads by it.`,
        )
      }
    }
  }

  // ownerField declared but the named column isn't userBound — easy to
  // create a row claiming someone else's ownership.
  if (schema.ownerField) {
    const col = schema.columns.find((c) => c.name === schema.ownerField)
    if (col && !col.userBound) {
      warnings.push(
        `[${schema.name}] ownerField is '${schema.ownerField}' but that column is not marked userBound: true. ` +
          `A client can create a row with someone else's id in this field, bypassing 'own' permission checks. ` +
          `Add userBound: true (and ideally immutable: true) to the column.`,
      )
    }
  }

  // userBound columns that aren't text storage — userBound sets the
  // field to the caller's userId (a string), so non-text storage is a
  // schema mistake that will surface as a coercion error at write time.
  for (const col of schema.columns) {
    if (col.userBound && col.storage !== 'text') {
      warnings.push(
        `[${schema.name}] column '${col.name}' is userBound but storage is '${col.storage}'. ` +
          `userBound stamps the user id (a string); use storage: 'text'.`,
      )
    }
  }

  return warnings
}

export class SchemaRegistry {
  private trusted: Map<string, CollectionSchema> = new Map()

  constructor(schemas: CollectionSchema[] = []) {
    for (const schema of schemas) {
      this.registerTrusted(schema)
    }
  }

  registerTrusted(schema: CollectionSchema): void {
    for (const w of lintSchema(schema)) {
      console.warn(`[schema-lint] ${w}`)
    }
    this.trusted.set(schema.name, schema)
  }

  get(name: string): CollectionSchema | undefined {
    return this.trusted.get(name)
  }

  has(name: string): boolean {
    return this.trusted.has(name)
  }

  all(): CollectionSchema[] {
    return Array.from(this.trusted.values())
  }

  names(): string[] {
    return Array.from(this.trusted.keys())
  }
}

// ============================================================================
// Permission Analysis
// ============================================================================

export type PermissionSource = 'explicit' | 'wildcard' | 'default-deny'

export interface ResolvedPermission {
  level: PermissionLevel | boolean
  source: PermissionSource
}

export interface CollectionPermissionSummary {
  collection: string
  ownerField?: string
  collaboratorsField?: string
  teamField?: string
  columns: ColumnDefinition[]
  permissions: Record<
    string,
    {
      read: ResolvedPermission
      create: ResolvedPermission
      update: ResolvedPermission
      delete: ResolvedPermission
      writableFields?: string[]
    }
  >
}

export interface PermissionAnalysis {
  roles: string[]
  collections: CollectionPermissionSummary[]
}

export function analyzePermissions(schemas: CollectionSchema[]): PermissionAnalysis {
  const roleSet = new Set<string>()
  for (const schema of schemas) {
    for (const role of Object.keys(schema.permissions)) roleSet.add(role)
  }
  roleSet.delete('*')
  const roles = Array.from(roleSet)

  const collections: CollectionPermissionSummary[] = schemas.map((schema) => {
    const permissions: CollectionPermissionSummary['permissions'] = {}
    for (const role of roles) {
      let source: PermissionSource
      let perms: RolePermissions
      if (schema.permissions[role]) {
        source = 'explicit'
        perms = schema.permissions[role]
      } else if (schema.permissions['*']) {
        source = 'wildcard'
        perms = schema.permissions['*']
      } else {
        source = 'default-deny'
        perms = { read: false, create: false, update: false, delete: false }
      }
      permissions[role] = {
        read: { level: perms.read, source },
        create: { level: perms.create, source },
        update: { level: perms.update, source },
        delete: { level: perms.delete, source },
        writableFields: perms.writableFields,
      }
    }
    return {
      collection: schema.name,
      ownerField: schema.ownerField,
      collaboratorsField: schema.collaboratorsField,
      teamField: schema.teamField,
      columns: schema.columns,
      permissions,
    }
  })

  return { roles, collections }
}
