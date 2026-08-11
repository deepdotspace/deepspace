import type { Role } from '../../shared/roles'

interface AppRoleEnv {
  RECORD_ROOMS: DurableObjectNamespace
  DEEPSPACE_APP_ID: string
  OWNER_USER_ID: string
}

/** Resolve a user's current role from the app's canonical users collection. */
export async function resolveAppRole(env: AppRoleEnv, userId: string): Promise<Role> {
  if (userId === env.OWNER_USER_ID) return 'admin'

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
      }),
    )
    const json = (await res.json()) as {
      success?: boolean
      data?: { record?: { data?: { role?: unknown } } }
    }
    const role = json.data?.record?.data?.role
    return json.success && (role === 'admin' || role === 'member') ? role : 'viewer'
  } catch {
    return 'viewer'
  }
}
