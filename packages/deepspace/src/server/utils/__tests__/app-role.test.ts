import { describe, expect, it } from 'vitest'
import { resolveAppMembership } from '../app-role'

function makeEnv(
  rows: Record<string, Record<string, { role: string }>>,
  refusal?: string,
) {
  const names: string[] = []
  const env = {
    DEEPSPACE_APP_ID: 'app_01H',
    OWNER_USER_ID: 'owner',
    RECORD_ROOMS: {
      idFromName(name: string) {
        names.push(name)
        return name
      },
      get(name: string) {
        return {
          async fetch(request: Request) {
            const { params } = (await request.json()) as { params: { recordId: string } }
            if (refusal) return Response.json({ success: false, error: refusal })
            const data = rows[name]?.[params.recordId]
            return Response.json(
              data
                ? { success: true, data: { record: { data } } }
                : { success: false, error: `Record not found: users/${params.recordId}` },
            )
          },
        }
      },
    } as unknown as DurableObjectNamespace,
  }
  return { env, names }
}

describe('resolveAppMembership', () => {
  it("reads the app's room by default", async () => {
    const { env, names } = makeEnv({ 'app:app_01H': { u1: { role: 'member' } } })
    expect(await resolveAppMembership(env, 'u1')).toEqual({ member: true, role: 'member' })
    expect(names).toEqual(['app:app_01H'])
  })

  it('reads the room an app chose for the caller', async () => {
    const { env, names } = makeEnv({
      'app:app_01H': {},
      'notes:u1': { u1: { role: 'admin' } },
    })
    expect(await resolveAppMembership(env, 'u1', undefined, { room: 'notes:u1' })).toEqual({
      member: true,
      role: 'admin',
    })
    expect(await resolveAppMembership(env, 'u1')).toEqual({ member: false, role: 'viewer' })
    expect(names).toEqual(['notes:u1', 'app:app_01H'])
  })

  it('accepts the owner without a read', async () => {
    const { env, names } = makeEnv({})
    expect(await resolveAppMembership(env, 'owner', undefined, { room: 'notes:owner' })).toEqual({
      member: true,
      role: 'admin',
    })
    expect(names).toEqual([])
  })

  it('reports a refused read as unverified, never as "not a member"', async () => {
    const { env } = makeEnv({}, 'Unknown collection: users')
    expect(await resolveAppMembership(env, 'u1')).toBeNull()
  })
})
