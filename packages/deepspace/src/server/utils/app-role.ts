import { isWriterRole, type Role } from '../../shared/roles'

interface AppRoleEnv {
  RECORD_ROOMS: DurableObjectNamespace
  DEEPSPACE_APP_ID: string
  OWNER_USER_ID: string
}

export interface AppMembership {
  /** True when the caller's row exists in the app's canonical users collection. */
  member: boolean
  role: Role
}

/**
 * Resolve a user's membership and role from the app's canonical users
 * collection in one read. This is the single definition of "is this user in
 * the app" — gate new surfaces with it rather than re-deriving membership
 * from another tool call. Returns null when the read itself failed (room
 * unreachable, aborted): callers must treat that as "could not verify", never
 * as "not a member".
 */
export async function resolveAppMembership(
  env: AppRoleEnv,
  userId: string,
  signal?: AbortSignal,
): Promise<AppMembership | null> {
  if (userId === env.OWNER_USER_ID) return { member: true, role: 'admin' }

  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
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
      data?: { record?: { data?: { role?: unknown } } }
    }
    if (!json.success || !json.data?.record) return { member: false, role: 'viewer' }
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
