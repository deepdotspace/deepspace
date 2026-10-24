import type { CollectionSchema, RolePermissions } from 'deepspace/schema'
// Anonymous sockets have role viewer. An exact role overrides the '*' fallback.
const visitor: RolePermissions = {
  read: true,
  create: true,
  update: true,
  delete: false,
  writableFields: ['text', 'done'],
}
export const ideasSchema: CollectionSchema = {
  name: 'ideas',
  columns: [
    {
      name: 'text',
      storage: 'text',
      interpretation: 'plain',
      required: true,
      immutable: true,
      maxLength: 280,
    },
    { name: 'done', storage: 'number', interpretation: { kind: 'boolean' }, default: false },
  ],
  permissions: {
    '*': visitor,
    viewer: visitor,
    member: visitor,
    admin: { read: true, create: true, update: true, delete: true },
  },
}
