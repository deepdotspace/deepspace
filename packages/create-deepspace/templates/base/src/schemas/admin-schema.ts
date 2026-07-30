/**
 * Admin Feature - Schema
 *
 * Admin-only settings collection for key-value app configuration.
 */

import type { CollectionSchema } from 'deepspace/worker'

export const settingsSchema: CollectionSchema = {
  name: 'settings',
  columns: [
    { name: 'key', storage: 'text', interpretation: 'plain' },
    { name: 'value', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    viewer: { read: false, create: false, update: false, delete: false },
    member: { read: false, create: false, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
