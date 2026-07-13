/**
 * Canvas Feature - Schema
 *
 * A canvas document collection for listing/managing canvas documents.
 * The actual shape data lives in the CanvasRoom DO (Yjs-backed),
 * not in RecordRoom. This schema is just for document metadata.
 */

import type { CollectionSchema } from 'deepspace/worker'

export const canvasSchema: CollectionSchema = {
  name: 'canvases',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true, userBound: true, immutable: true },
  ],
  ownerField: 'ownerId',
  permissions: {
    viewer: {
      read: true,
      create: false,
      update: false,
      delete: false,
    },
    member: {
      read: true,
      create: true,
      update: 'own',
      delete: 'own',
    },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
