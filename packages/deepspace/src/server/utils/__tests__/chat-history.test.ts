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
import { appendMessage, deleteChatCascade, getChat, updateChat } from '../chat-history'
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

// ---------------------------------------------------------------------------
// Write-after-delete guards and the bounded cascade
// ---------------------------------------------------------------------------

type Call = { tool: string; params: Record<string, unknown> }

/** A RecordRoom stub whose reply to each tool call the test decides. */
function roomStub(respond: (call: Call) => { success: boolean; data?: unknown; error?: string }): {
  stub: DurableObjectStub
  calls: Call[]
} {
  const calls: Call[] = []
  const stub = {
    fetch: async (req: Request) => {
      const body = (await req.json()) as { tool: string; params: Record<string, unknown> }
      calls.push({ tool: body.tool, params: body.params })
      return new Response(JSON.stringify(respond(body)), {
        headers: { 'content-type': 'application/json' },
      })
    },
  } as unknown as DurableObjectStub
  return { stub, calls }
}

/** Replies as a room holding exactly the chats in `chats` (by owner). */
function roomWithChat(owner: string | null) {
  return roomStub((call) => {
    if (call.tool === 'records.get') {
      return { success: true, data: { record: owner ? chatRecord(owner) : null } }
    }
    return { success: true, data: {} }
  })
}

describe('write-after-delete: updateChat', () => {
  it('does not write when the chat is gone — records.update is an upsert and would resurrect it', async () => {
    const { stub, calls } = roomWithChat(null)

    await expect(updateChat(stub, 'chat-1', OWNER, { title: 'Auto title' })).resolves.toBe(false)

    expect(calls.map((c) => c.tool)).toEqual(['records.get'])
  })

  it('writes and reports true when the chat still exists', async () => {
    const { stub, calls } = roomWithChat(OWNER)

    await expect(updateChat(stub, 'chat-1', OWNER, { model: 'm' })).resolves.toBe(true)

    expect(calls.map((c) => c.tool)).toEqual(['records.get', 'records.update'])
    expect(calls[1].params).toMatchObject({ collection: 'ai-chats', recordId: 'chat-1' })
  })

  it('does not write to another user\'s chat', async () => {
    const { stub, calls } = roomWithChat(OWNER)

    await expect(updateChat(stub, 'chat-1', OTHER, { title: 'nope' })).resolves.toBe(false)

    expect(calls.map((c) => c.tool)).toEqual(['records.get'])
  })
})

describe('write-after-delete: appendMessage', () => {
  const message = {
    id: 'msg-1',
    chatId: 'chat-1',
    userId: OWNER,
    role: 'assistant' as const,
    content: 'hi',
  }

  it('skips the write when the chat was deleted mid-stream', async () => {
    const { stub, calls } = roomWithChat(null)

    await expect(appendMessage(stub, message)).resolves.toBe(false)

    expect(calls.map((c) => c.tool)).toEqual(['records.get'])
  })

  it('writes and reports true while the chat exists', async () => {
    const { stub, calls } = roomWithChat(OWNER)

    await expect(appendMessage(stub, message)).resolves.toBe(true)

    expect(calls.map((c) => c.tool)).toEqual(['records.get', 'records.create'])
  })
})

/** A room holding `count` messages, draining them through records.deleteWhere. */
function roomWithMessages(count: number, opts: { deleteWhereFails?: boolean } = {}) {
  let remaining = count
  return roomStub((call) => {
    if (call.tool === 'records.deleteWhere') {
      if (opts.deleteWhereFails) return { success: false, error: 'storage exploded' }
      const limit = call.params.limit as number
      const deleted = Math.min(remaining, limit)
      remaining -= deleted
      return { success: true, data: { deleted } }
    }
    return { success: true, data: { deleted: true } }
  })
}

describe('deleteChatCascade is bounded in subrequests', () => {
  it('spends one subrequest per page, not one per message', async () => {
    // 4500 messages used to mean 4501 stub.fetch calls — past the Workers
    // subrequest cap, so the tail of the chat (and often the chat row itself)
    // survived the delete.
    const { stub, calls } = roomWithMessages(4500)

    await deleteChatCascade(stub, 'chat-1', OWNER)

    const deleteWheres = calls.filter((c) => c.tool === 'records.deleteWhere')
    expect(deleteWheres).toHaveLength(23) // 22 full pages of 200 + a short one
    expect(deleteWheres[0].params).toMatchObject({
      collection: 'ai-messages',
      where: { chatId: 'chat-1' },
    })
    expect(calls.filter((c) => c.tool === 'records.delete')).toEqual([
      { tool: 'records.delete', params: { collection: 'ai-chats', recordId: 'chat-1' } },
    ])
    expect(calls).toHaveLength(24)
  })

  it('stops after one call when the chat has no messages', async () => {
    const { stub, calls } = roomWithMessages(0)

    await deleteChatCascade(stub, 'chat-1', OWNER)

    expect(calls.map((c) => c.tool)).toEqual(['records.deleteWhere', 'records.delete'])
  })

  it('still deletes the chat row when message deletion fails, then reports the failure', async () => {
    // The row must leave the user's listing even if messages orphan — but the
    // caller must not be told the cascade succeeded.
    const { stub, calls } = roomWithMessages(10, { deleteWhereFails: true })

    await expect(deleteChatCascade(stub, 'chat-1', OWNER)).rejects.toThrow(/storage exploded/)

    expect(calls.map((c) => c.tool)).toEqual(['records.deleteWhere', 'records.delete'])
  })
})

describe('vi sanity', () => {
  it('has no leaked global fetch stubbing', () => {
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false)
  })
})
