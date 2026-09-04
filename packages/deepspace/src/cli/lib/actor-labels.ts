/**
 * Best-effort userId → human label map for the coordination read commands
 * (activity, workspace list). Raw actor ids are stable
 * API surface and stay in --json; the HUMAN views resolve them to emails
 * where the platform can: the caller's own id from the JWT ("(you)"), and
 * collaborators from the api-worker roster (owner-scoped — a collaborator's
 * view quietly falls back to raw ids). Any source failing degrades to ids,
 * never to a failed command.
 */

import { API_URL } from '../env'
import { decodeJwtPayload } from '../../shared/jwt'
import { apiFetch } from './api'

export async function actorLabels(token: string, appId: string): Promise<Map<string, string>> {
  const labels = new Map<string, string>()
  try {
    const { sub, email } = decodeJwtPayload<{ sub?: string; email?: string }>(token)
    if (sub && email) labels.set(sub, `${email} (you)`)
  } catch {
    // unreadable token — ids only
  }
  try {
    const { collaborators } = await apiFetch<{
      collaborators: Array<{ userId: string; emailDisplay: string }>
    }>(API_URL, token, `/api/app-collaborators/${encodeURIComponent(appId)}`)
    for (const c of collaborators) {
      if (!labels.has(c.userId)) labels.set(c.userId, c.emailDisplay)
    }
  } catch {
    // not the owner / roster unavailable — ids only
  }
  return labels
}
