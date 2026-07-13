import type { CollectionSchema } from 'deepspace/worker'
import { USERS_COLUMNS } from 'deepspace/worker'

export const usersSchema: CollectionSchema = {
  name: 'users',
  columns: [...USERS_COLUMNS],
  permissions: {
    viewer: { read: 'own', create: false, update: 'own', delete: false },
    member: { read: true, create: false, update: 'own', delete: false },
    admin: { read: true, create: false, update: true, delete: true },
  },
}
