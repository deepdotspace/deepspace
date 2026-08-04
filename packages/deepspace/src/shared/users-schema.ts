import type { ColumnDefinition } from './types'

/** Standard system-managed user columns shared by browser and Worker schemas. */
export const USERS_COLUMNS: readonly ColumnDefinition[] = [
  { name: 'email', storage: 'text', interpretation: 'plain' },
  { name: 'name', storage: 'text', interpretation: 'plain' },
  { name: 'imageUrl', storage: 'text', interpretation: 'plain' },
  { name: 'role', storage: 'text', interpretation: 'plain' },
  { name: 'createdAt', storage: 'text', interpretation: { kind: 'datetime' } },
  { name: 'lastSeenAt', storage: 'text', interpretation: { kind: 'datetime' } },
]
