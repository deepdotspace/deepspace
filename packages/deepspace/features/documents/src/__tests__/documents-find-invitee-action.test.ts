import { describe, expect, it, vi } from 'vitest'
import type { ActionContext, ActionTools } from 'deepspace/worker'
import { documentsFindInviteeAction } from '../documents-find-invitee-action'

type Doc = { ownerId: string }
type UserRow = { email: string; name: string }

/**
 * The action's tools run RBAC-off, so the fake answers whatever the handler
 * asks for; the assertions are about what the handler asks for and returns.
 */
function fakeTools(opts: {
  document?: Doc | null
  users?: Array<{ recordId: string; data: UserRow }>
  usersQueryFails?: boolean
}): ActionTools & { query: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async () =>
    opts.document
      ? {
          success: true as const,
          data: {
            record: {
              recordId: 'doc-1',
              data: opts.document,
              createdBy: opts.document.ownerId,
              createdAt: 't',
              updatedAt: 't',
            },
          },
        }
      : { success: false as const, error: 'Record not found' },
  )
  const query = vi.fn(async () =>
    opts.usersQueryFails
      ? { success: false as const, error: 'boom' }
      : {
          success: true as const,
          data: {
            records: (opts.users ?? []).map((u) => ({
              ...u,
              createdBy: u.recordId,
              createdAt: 't',
              updatedAt: 't',
            })),
            count: (opts.users ?? []).length,
          },
        },
  )
  return { get, query } as unknown as ActionTools & { query: ReturnType<typeof vi.fn> }
}

function ctx(userId: string, params: Record<string, unknown>, tools: ActionTools): ActionContext {
  return { userId, params, tools, env: {}, callerJwt: 'jwt' }
}

describe('documentsFindInviteeAction', () => {
  it('refuses a call without a document id or an email', async () => {
    const tools = fakeTools({ document: { ownerId: 'owner' } })
    expect(await documentsFindInviteeAction(ctx('owner', { email: 'b@x.test' }, tools))).toEqual({
      success: false,
      error: 'docId and email are required',
    })
    expect(await documentsFindInviteeAction(ctx('owner', { docId: 'doc-1' }, tools))).toEqual({
      success: false,
      error: 'docId and email are required',
    })
    expect(tools.query).not.toHaveBeenCalled()
  })

  it('refuses an unknown document with the same answer as a foreign one (no existence oracle)', async () => {
    const tools = fakeTools({ document: null })
    const result = await documentsFindInviteeAction(
      ctx('owner', { docId: 'missing', email: 'b@x.test' }, tools),
    )
    expect(result).toEqual({ success: false, error: 'Only the document owner can share it' })
    expect(tools.query).not.toHaveBeenCalled()
  })

  it('refuses a caller who is not the document owner without touching the users table', async () => {
    const tools = fakeTools({
      document: { ownerId: 'owner' },
      users: [{ recordId: 'u-b', data: { email: 'b@x.test', name: 'B' } }],
    })
    const result = await documentsFindInviteeAction(
      ctx('editor', { docId: 'doc-1', email: 'b@x.test' }, tools),
    )
    expect(result).toEqual({ success: false, error: 'Only the document owner can share it' })
    expect(tools.query).not.toHaveBeenCalled()
  })

  it('resolves an exact email to the public user id for the document owner', async () => {
    const tools = fakeTools({
      document: { ownerId: 'owner' },
      users: [{ recordId: 'u-b', data: { email: 'b@x.test', name: 'B' } }],
    })
    const result = await documentsFindInviteeAction(
      ctx('owner', { docId: 'doc-1', email: 'b@x.test' }, tools),
    )
    // Exactly the id: no email, name, or other column leaves the action.
    expect(result).toEqual({ success: true, data: { found: true, userId: 'u-b' } })
    expect(tools.query).toHaveBeenCalledTimes(1)
    expect(tools.query).toHaveBeenCalledWith('users', { where: { email: 'b@x.test' }, limit: 1 })
  })

  it('normalizes the email the way the auth plane stores it before matching', async () => {
    const tools = fakeTools({
      document: { ownerId: 'owner' },
      users: [{ recordId: 'u-b', data: { email: 'b@x.test', name: 'B' } }],
    })
    await documentsFindInviteeAction(
      ctx('owner', { docId: 'doc-1', email: '  B@X.Test \n' }, tools),
    )
    expect(tools.query).toHaveBeenCalledWith('users', { where: { email: 'b@x.test' }, limit: 1 })
  })

  it('reports found: false when nobody with that email has signed in', async () => {
    const tools = fakeTools({ document: { ownerId: 'owner' }, users: [] })
    const result = await documentsFindInviteeAction(
      ctx('owner', { docId: 'doc-1', email: 'nobody@x.test' }, tools),
    )
    expect(result).toEqual({ success: true, data: { found: false } })
  })

  it('surfaces a failed users query instead of reporting not found', async () => {
    const tools = fakeTools({ document: { ownerId: 'owner' }, usersQueryFails: true })
    const result = await documentsFindInviteeAction(
      ctx('owner', { docId: 'doc-1', email: 'b@x.test' }, tools),
    )
    expect(result).toEqual({ success: false, error: 'User lookup failed' })
  })
})
