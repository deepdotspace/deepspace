/**
 * Client half of the Share dialog's invitee lookup: calls the feature's
 * owner-only server action (`src/actions/documents-find-invitee.ts`) with the
 * app session's bearer token and hands back its answer.
 *
 * Kept apart from the dialog so the wire contract is testable without
 * rendering the modal.
 */

import { getAuthToken } from 'deepspace'
import type { ActionResult } from 'deepspace/worker'
import type { DocumentsInviteeLookup } from '@/actions/documents-find-invitee'

const ACTION_PATH = '/api/actions/documents-find-invitee'

/** The action's own result envelope, or the route's `{ error }` for 401/404. */
type ActionEnvelope = ActionResult<DocumentsInviteeLookup> | { error?: string }

/** Throws with the action's own refusal text, or a status-bearing message. */
export async function findDocumentsInvitee(
  docId: string,
  email: string,
): Promise<DocumentsInviteeLookup> {
  const token = await getAuthToken()
  const res = await fetch(ACTION_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ docId, email }),
  })
  const body = (await res.json().catch(() => null)) as ActionEnvelope | null
  if (!res.ok || !body || !('success' in body) || !body.success) {
    throw new Error((body && 'error' in body && body.error) || `Lookup failed (${res.status})`)
  }
  return body.data
}
