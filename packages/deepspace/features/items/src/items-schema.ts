/**
 * Items Feature - Schema
 *
 * A simple collection with ownership demonstrating:
 * - ownerField for 'own' permission checks
 * - userBound fields that auto-populate with current user ID
 * - immutable fields that cannot change after creation
 * - Basic CRUD with role-based permissions
 */

import type { CollectionSchema } from 'deepspace/worker'

export const itemsSchema: CollectionSchema = {
  name: 'items',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true },
    { name: 'description', storage: 'text', interpretation: 'plain' },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['active', 'archived'] }, default: 'active' },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true, userBound: true, immutable: true },
  ],
  ownerField: 'ownerId',
  permissions: {
    viewer: { read: true, create: false, update: false, delete: false },
    member: { read: true, create: true, update: 'own', delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
