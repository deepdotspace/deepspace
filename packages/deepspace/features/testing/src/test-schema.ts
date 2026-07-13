/**
 * Test Items Schema — exercises RBAC and CRUD for e2e testing.
 */

import type { CollectionSchema } from 'deepspace/worker'
import { ROLE_ANONYMOUS } from 'deepspace/worker'

export const testItemsSchema: CollectionSchema = {
  name: 'test-items',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain' },
    { name: 'description', storage: 'text', interpretation: 'plain' },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['draft', 'published', 'archived'] } },
    { name: 'createdBy', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'createdBy',
  permissions: {
    [ROLE_ANONYMOUS]: { read: 'published', create: false, update: false, delete: false },
    member: { read: true, create: true, update: 'own', delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
  visibilityField: { field: 'status', value: 'published' },
}
