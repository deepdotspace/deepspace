/**
 * Docs Feature — Record schemas
 *
 * `documents`: collaborative docs with optional folder placement.
 * `doc_folders`: user-owned folders for library organization.
 */

import type { CollectionSchema } from 'deepspace/worker'

const folderPermissions = {
  viewer: {
    read: true,
    create: false,
    update: false,
    delete: false,
  },
  member: {
    read: true,
    create: true,
    update: true,
    delete: 'own',
  },
  admin: { read: true, create: true, update: true, delete: true },
} as const

export const docFoldersSchema: CollectionSchema = {
  name: 'doc_folders',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain', required: true },
    {
      name: 'ownerId',
      storage: 'text',
      interpretation: 'plain',
      required: true,
      userBound: true,
      immutable: true,
    },
  ],
  ownerField: 'ownerId',
  permissions: folderPermissions,
}

export const docsSchema: CollectionSchema = {
  name: 'documents',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true },
    { name: 'content', storage: 'text', interpretation: 'plain' },
    {
      name: 'ownerId',
      storage: 'text',
      interpretation: 'plain',
      required: true,
      userBound: true,
      immutable: true,
    },
    { name: 'collaborators', storage: 'text', interpretation: 'plain' },
    { name: 'editors', storage: 'text', interpretation: 'plain' },
    { name: 'folderId', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'ownerId',
  collaboratorsField: 'collaborators',
  permissions: {
    viewer: {
      read: 'collaborator',
      create: false,
      update: false,
      delete: false,
    },
    member: {
      read: 'collaborator',
      create: true,
      update: 'own',
      delete: 'own',
    },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

/** Pass into `schemas` with spread: `[...docsCollections, ...]` */
export const docsCollections: CollectionSchema[] = [docsSchema, docFoldersSchema]
