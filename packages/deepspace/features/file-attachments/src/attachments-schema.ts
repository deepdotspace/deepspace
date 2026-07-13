/**
 * File Attachments Feature - Schema
 *
 * Stores file metadata (name, type, size, R2 key) in a collection.
 * Actual binary data lives in R2 via useR2Files.
 *
 * Demonstrates:
 * - ownerField for 'own' permission checks
 * - userBound fields that auto-populate with current user ID
 * - Pairing collection metadata with R2 file storage
 */

import type { CollectionSchema } from 'deepspace/worker'

export const attachmentsSchema: CollectionSchema = {
  name: 'attachments',
  columns: [
    { name: 'fileName', storage: 'text', interpretation: 'plain', required: true },
    { name: 'fileKey', storage: 'text', interpretation: 'plain', required: true },
    { name: 'mimeType', storage: 'text', interpretation: 'plain', required: true },
    { name: 'fileSize', storage: 'number', interpretation: 'plain', required: true },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true, userBound: true, immutable: true },
  ],
  ownerField: 'ownerId',
  // SECURITY: `read: 'own'` for member/viewer scopes the realtime subscription
  // to records the caller owns. With `read: true` (the previous setting),
  // every signed-in user received every attachment row — including other
  // users' fileKeys, which makes the R2 binaries reachable via the per-app
  // /api/files/<key> endpoint. Admins still see all rows so they can moderate.
  permissions: {
    viewer: {
      read: 'own',
      create: false,
      update: false,
      delete: false,
    },
    member: {
      read: 'own',
      create: true,
      update: 'own',
      delete: 'own',
    },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
