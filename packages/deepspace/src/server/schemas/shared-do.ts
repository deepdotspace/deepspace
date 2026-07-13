/**
 * Shared Durable Object Schemas
 *
 * Central registry of global DO types with fixed schemas.
 * Apps connect to shared DOs via SHARED_CONNECTIONS in constants.ts.
 * The ScopeRegistry resolves collection names to the correct scope automatically.
 *
 * Scope tiers:
 * - App DO (app:{appHandle}) — private to each app, app defines tables
 * - Dir DO (dir:{appHandle}) — cross-app directory (conversations, communities, posts)
 * - Workspace DO (workspace:default) — shared business data (teams, tasks, people, ledger)
 * - Conv DO (conv:{id}) — single conversation (messages, reactions, members)
 */

import type { CollectionSchema } from './registry'
import { CONVERSATION_SCHEMAS, VOTING_SCHEMAS } from './conversation'
import { DIRECTORY_SCHEMAS } from './directory'
import { WORKSPACE_SCHEMAS } from './workspace'

// ============================================================================
// Registry types
// ============================================================================

export interface SharedConnection {
  type: string
  instanceId?: string
}

export interface GlobalDOType {
  name: string
  schemas: CollectionSchema[]
  description: string
}

// ============================================================================
// Global DO type registry
// ============================================================================

export const GLOBAL_DO_TYPES: GlobalDOType[] = [
  {
    name: 'workspace',
    schemas: WORKSPACE_SCHEMAS,
    description: 'Shared workspace data (teams, tasks, projects, people, ledger)',
  },
  {
    name: 'conv',
    schemas: [...CONVERSATION_SCHEMAS, ...VOTING_SCHEMAS],
    description: 'Conversations (messages, reactions, members, voting)',
  },
  {
    name: 'dir',
    schemas: DIRECTORY_SCHEMAS,
    description: 'App directory (conversations, communities, posts) — cross-app accessible',
  },
]

/** All valid global DO type names. */
export const GLOBAL_DO_TYPE_NAMES = GLOBAL_DO_TYPES.map(t => t.name)

/** Look up a global DO type by name, returns null if not found. */
export function getGlobalDOType(name: string): GlobalDOType | null {
  return GLOBAL_DO_TYPES.find(t => t.name === name) ?? null
}

/** Get the fixed schemas for a global DO type. Returns empty array if unknown type. */
export function getGlobalDOSchemas(typeName: string): CollectionSchema[] {
  return getGlobalDOType(typeName)?.schemas ?? []
}

/** All collection names reserved by global DO types. Apps must not reuse these. */
export const RESERVED_COLLECTION_NAMES = new Set(
  GLOBAL_DO_TYPES.flatMap(t => t.schemas.map(s => s.name)),
)
