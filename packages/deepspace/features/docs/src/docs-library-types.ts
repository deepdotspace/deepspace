/**
 * Library navigation + folder types for docs UI (aligned with docs2).
 */

export interface DocFolderFields {
  name: string
  ownerId: string
}

export type LibraryNavSelection =
  | { kind: 'all' }
  | { kind: 'shared' }
  | { kind: 'favorites' }
  | { kind: 'uncategorized' }
  | { kind: 'folder'; folderId: string }
