import { isWriterRole, type Role } from '../../shared/roles'
import { RECORD_NOT_FOUND } from '../../shared/protocol/constants'

interface AppRoleEnv {
  RECORD_ROOMS: DurableObjectNamespace
  DEEPSPACE_APP_ID: string
  OWNER_USER_ID: string
}

export interface AppMembership {
  /** True when the caller's row exists in the room's users collection. */
  member: boolean
  role: Role
}

/**
 * Resolve a user's membership and role from a room's users collection in one
 * read: the app's canonical room, or the `room` an app that keeps a room per
 * user or team chose for this verified caller. A signed-in visit to that room
 * creates the row. This is the single definition of "is this user in the
 * app" — gate new surfaces with it rather than re-deriving membership from
 * another tool call. Only a missing row means "not a member". Returns null
 * when the read itself failed (room unreachable, aborted, or any refusal
 * other than "not found"): callers must treat that as "could not verify",
 * never as "not a member".
 */
export async function resolveAppMembership(
  env: AppRoleEnv,
  userId: string,
  signal?: AbortSignal,
  options: { room?: string } = {},
): Promise<AppMembership | null> {
  if (userId === env.OWNER_USER_ID) return { member: true, role: 'admin' }

  const stub = env.RECORD_ROOMS.get(
    env.RECORD_ROOMS.idFromName(options.room ?? `app:${env.DEEPSPACE_APP_ID}`),
  )
  try {
    const res = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': env.OWNER_USER_ID,
          'X-App-Action': 'true',
        },
        body: JSON.stringify({
          tool: 'records.get',
          params: { collection: 'users', recordId: userId },
        }),
        signal,
      }),
    )
    const json = (await res.json()) as {
      success?: boolean
      error?: unknown
      data?: { record?: { data?: { role?: unknown } } }
    }
    if (!json.success) {
      const missing = typeof json.error === 'string' && json.error.startsWith(RECORD_NOT_FOUND)
      return missing ? { member: false, role: 'viewer' } : null
    }
    if (!json.data?.record) return { member: false, role: 'viewer' }
    const role = json.data.record.data?.role
    return { member: true, role: isWriterRole(role) ? role : 'viewer' }
  } catch {
    return null
  }
}

/** Resolve a user's current role from the app's canonical users collection. */
export async function resolveAppRole(env: AppRoleEnv, userId: string): Promise<Role> {
  return (await resolveAppMembership(env, userId))?.role ?? 'viewer'
}
