/**
 * getChat is the ai-chat module's only authorization boundary.
 *
 * Every helper here talks to RecordRoom with `X-App-Action`, which turns off
 * per-record RBAC — so RecordRoom returns whatever row was asked for,
 * regardless of who is asking. Before this suite existed, `getChat` passed
 * `userId` down to the tools API (where it is ignored under X-App-Action) and
 * never compared it to the stored owner, so `PATCH`/`DELETE /api/ai/chats/:id`
 * happily mutated and cascade-deleted other users' chats.
 */

import { describe, expect, it, vi } from 'vitest'
import { getChat } from '../chat-history'
import { RECORD_NOT_FOUND } from '../../../shared/protocol/constants'

const OWNER = 'user-owner'
const OTHER = 'user-other'

/** A RecordRoom stub that returns `record` for any records.get. */
function stubReturning(record: unknown): {
  stub: DurableObjectStub
  calls: Array<{ tool: string; headers: Record<string, string> }>
} {
  const calls: Array<{ tool: string; headers: Record<string, string> }> = []
  const stub = {
    fetch: async (req: Request) => {
      const body = (await req.json()) as { tool: string }
      calls.push({
        tool: body.tool,
        headers: Object.fromEntries(req.headers as unknown as Iterable<[string, string]>),
      })
      return new Response(JSON.stringify({ success: true, data: { record } }), {
        headers: { 'content-type': 'application/json' },
      })
    },
  } as unknown as DurableObjectStub
  return { stub, calls }
}

function chatRecord(userId: string) {
  return {
    recordId: 'chat-1',
    data: { userId, title: 'Some chat' },
    createdBy: userId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('getChat ownership boundary', () => {
  it('returns the chat when the caller owns it', async () => {
    const { stub } = stubReturning(chatRecord(OWNER))

    const chat = await getChat(stub, 'chat-1', OWNER)

    expect(chat).not.toBeNull()
    expect(chat?.recordId).toBe('chat-1')
    expect(chat?.userId).toBe(OWNER)
  })

  it('returns null when the row belongs to a different user', async () => {
    // RecordRoom hands the row over — X-App-Action means it applies no RBAC.
    // getChat itself must be what refuses.
    const { stub } = stubReturning(chatRecord(OWNER))

    const chat = await getChat(stub, 'chat-1', OTHER)

    expect(chat).toBeNull()
  })

  it('makes a cross-user hit indistinguishable from a miss', async () => {
    const foreign = await getChat(stubReturning(chatRecord(OWNER)).stub, 'chat-1', OTHER)
    const missing = await getChat(stubReturning(null).stub, 'chat-1', OTHER)

    // Same observable result, so chat ids stay unenumerable.
    expect(foreign).toBeNull()
    expect(missing).toBeNull()
  })

  it('still issues the underlying read with the RBAC-bypassing header', async () => {
    // Pins the reason the ownership check has to exist: if this header ever
    // stops being sent, RecordRoom would filter and the check would be
    // belt-and-braces — but while it IS sent, getChat is the only gate.
    const { stub, calls } = stubReturning(chatRecord(OWNER))

    await getChat(stub, 'chat-1', OWNER)

    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('records.get')
    expect(calls[0].headers['x-app-action']).toBe('true')
  })

  it('returns null rather than throwing when the record is absent', async () => {
    const stub = {
      fetch: async () =>
        new Response(JSON.stringify({ success: false, error: RECORD_NOT_FOUND }), {
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as DurableObjectStub

    await expect(getChat(stub, 'missing', OWNER)).resolves.toBeNull()
  })

  it('propagates unexpected tool failures instead of masking them as a miss', async () => {
    const stub = {
      fetch: async () =>
        new Response(JSON.stringify({ success: false, error: 'storage exploded' }), {
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as DurableObjectStub

    await expect(getChat(stub, 'chat-1', OWNER)).rejects.toThrow(/storage exploded/)
  })
})

describe('regression: the exact reported vector', () => {
  it('user B cannot read user A\'s chat through the id', async () => {
    // Reported repro: PATCH/DELETE /api/ai/chats/<A's chat> with B's bearer
    // returned {"ok":true} 200. Both routes gate on getChat returning
    // non-null, so this assertion is what makes them 404.
    const { stub } = stubReturning(chatRecord('user-A'))

    await expect(getChat(stub, 'chat-owned-by-A', 'user-B')).resolves.toBeNull()
  })
})

describe('vi sanity', () => {
  it('has no leaked global fetch stubbing', () => {
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false)
  })
})
