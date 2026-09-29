/**
 * Documents feature — owner-only invitee lookup.
 *
 * The Share dialog resolves an email to a user id. The client cannot do that
 * itself: the scaffold's users schema is `member: { read: 'own' }`, so an
 * ordinary member's `useQuery('users')` holds only their own row, and the
 * `useUsers()` roster is projected to public identity (no email). Only the
 * app owner (admin) reads full rows.
 *
 * Tools run RBAC-off, so this action is the authorization boundary: only the
 * owner of `docId` may ask, only by exact email, and the answer is the public
 * id alone — the same id every signed-in member already sees in the roster.
 *
 * What it deliberately adds: any member who owns a document (members can
 * create one) can learn whether an exact address has signed in to this app.
 * That is the price of invite-by-email; there is no list surface and no rate
 * limit here. Being RBAC-off, the query also ignores a users schema's
 * `roster: 'read-policy'` partitioning — an app that must not resolve
 * addresses across tenants should remove or adapt this action.
 */

import type { ActionHandler } from 'deepspace/worker'

export type DocumentsInviteeLookup = { found: false } | { found: true; userId: string }

type DocumentRow = { ownerId?: string }
type UserRow = { email?: string }

// `<unknown>`: the lookup never reads `env`, so it registers under any app's
// `Record<string, ActionHandler<Env>>` without naming that app's bindings.
export const documentsFindInviteeAction: ActionHandler<unknown> = async ({
  userId,
  params,
  tools,
}) => {
  const docId = typeof params.docId === 'string' ? params.docId : ''
  // The room stores emails lowercased (registerUser), so exact equality on the
  // normalized input is the whole match.
  const email = typeof params.email === 'string' ? params.email.trim().toLowerCase() : ''
  if (!docId || !email) return { success: false, error: 'docId and email are required' }

  // One refusal for "no such document" and "not yours": a distinct not-found
  // answer would let any member probe which document ids exist.
  const doc = await tools.get<DocumentRow>('documents', docId)
  if (!doc.success || doc.data.record.data.ownerId !== userId) {
    return { success: false, error: 'Only the document owner can share it' }
  }

  const users = await tools.query<UserRow>('users', { where: { email }, limit: 1 })
  if (!users.success) return { success: false, error: 'User lookup failed' }
  const match = users.data.records[0]
  const data: DocumentsInviteeLookup = match
    ? { found: true, userId: match.recordId }
    : { found: false }
  return { success: true, data }
}
