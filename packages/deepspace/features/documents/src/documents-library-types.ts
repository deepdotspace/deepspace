/** Shared document, ACL, folder, and navigation model for the Documents feature. */

export interface DocumentsDocumentFields {
  title: string
  ownerId: string
  collaborators?: string
  editors?: string
  folderId?: string
}

export interface DocFolderFields {
  name: string
  ownerId: string
}

export interface InviteAclDiff {
  /** Users dropped from `collaborators` entirely. */
  removedUserIds: string[]
  /** Users who lost the editor role but remain collaborators (now viewers). */
  demotedUserIds: string[]
  /** Existing collaborators who gained the editor role. */
  promotedUserIds: string[]
}

export type LibraryNavSelection =
  | { kind: 'all' }
  | { kind: 'shared' }
  | { kind: 'favorites' }
  | { kind: 'uncategorized' }
  | { kind: 'folder'; folderId: string }

export function parseDocumentsIdList(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}
