/**
 * Chat history helpers — wrap RecordRoom's tools API for ai-chats / ai-messages.
 *
 * Trust model: every helper here runs through `executeToolAsApp`, which sends
 * `X-App-Action: 'true'` and therefore **bypasses RecordRoom's per-record
 * RBAC entirely**. The `userId` argument these helpers take is the identity
 * they act *as* — it is NOT an authorization boundary, and RecordRoom will
 * not check it. The worker is the only trust boundary.
 *
 * `getChat` is that boundary for this module: it compares the stored
 * `userId` against the caller and returns null on a mismatch, so the
 * worker's `/api/ai/chat`, `PATCH /api/ai/chats/:id`, and
 * `DELETE /api/ai/chats/:id` routes 404 when a row is missing *or* owned by
 * someone else. Every write helper (`updateChat`, `appendMessage`,
 * `deleteChatCascade`) is reachable only behind that precheck; a new caller
 * that skips it is writing across users, so route new consumers through
 * `getChat` first.
 *
 * `updateChat` and `appendMessage` re-run that precheck themselves and report
 * `false` instead of writing when the chat is gone: `records.update` /
 * `records.create` are upserts, so a write racing the user's delete would
 * resurrect the chat as a ghost row or orphan messages under a chat that no
 * longer exists. The guard lives in the helpers, not the routes, so every copy
 * of the scaffolded chat routes gets it.
 *
 * The tools API returns records as `{ recordId, data, createdAt, updatedAt }`
 * envelopes; helpers below flatten them into ChatRow / ChatMessageRow.
 */

import { RECORD_NOT_FOUND } from '../../shared/protocol/constants'

export type ChatRow = {
  recordId: string
  userId: string
  title: string
  model?: string
  compactedSummary?: string
  compactedThroughId?: string
  createdAt: string
  updatedAt: string
}

export type ChatMessageRow = {
  recordId: string
  chatId: string
  userId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  parts?: unknown[]
  createdAt: string
}

type RecordEnvelope<T> = {
  recordId: string
  data: T
  createdBy: string
  createdAt: string
  updatedAt: string
}

type ChatColumns = {
  userId: string
  title?: string
  model?: string
  compactedSummary?: string
  compactedThroughId?: string
}

type MessageColumns = {
  chatId: string
  userId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  parts?: unknown[]
}

type ToolResponse<T> = { success: boolean; data?: T; error?: string }

async function executeToolAsApp<T>(
  stub: DurableObjectStub,
  userId: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<T> {
  const res = await stub.fetch(new Request('https://internal/api/tools/execute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': userId,
      'X-App-Action': 'true',
    },
    body: JSON.stringify({ tool, params }),
  }))
  const body = await res.json() as ToolResponse<T>
  if (!body.success) {
    throw new Error(`chat-history ${tool} failed: ${body.error ?? 'unknown error'}`)
  }
  return body.data as T
}

function toChatRow(env: RecordEnvelope<ChatColumns>): ChatRow {
  return {
    recordId: env.recordId,
    userId: env.data.userId,
    title: env.data.title ?? '',
    model: env.data.model,
    compactedSummary: env.data.compactedSummary,
    compactedThroughId: env.data.compactedThroughId,
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
  }
}

function toMessageRow(env: RecordEnvelope<MessageColumns>): ChatMessageRow {
  return {
    recordId: env.recordId,
    chatId: env.data.chatId,
    userId: env.data.userId,
    role: env.data.role,
    content: env.data.content ?? '',
    parts: env.data.parts,
    createdAt: env.createdAt,
  }
}

/**
 * Fetch a chat the caller owns, or null.
 *
 * This is the module's authorization boundary. `records.get` runs with
 * `X-App-Action`, so RecordRoom applies no per-record RBAC and will happily
 * return another user's row — the ownership comparison below is the only
 * thing standing between a caller and someone else's chat. A miss and a
 * cross-user hit deliberately look identical to the caller (both null, both
 * 404 at the route) so chat ids stay unenumerable.
 */
export async function getChat(
  stub: DurableObjectStub,
  chatId: string,
  userId: string,
): Promise<ChatRow | null> {
  try {
    const result = await executeToolAsApp<{ record: RecordEnvelope<ChatColumns> }>(stub, userId, 'records.get', {
      collection: 'ai-chats',
      recordId: chatId,
    })
    if (!result.record) return null
    const chat = toChatRow(result.record)
    return chat.userId === userId ? chat : null
  } catch (err) {
    // Shared constant, not a loose string: a miss and a cross-user hit must
    // keep producing the same null. If a room reworded this on its own, a
    // miss would throw while a foreign chat still returned null, and that
    // asymmetry is exactly the existence oracle the ownership check removes.
    if (err instanceof Error && err.message.includes(RECORD_NOT_FOUND)) return null
    throw err
  }
}

export async function createChat(
  stub: DurableObjectStub,
  userId: string,
  opts: { title?: string; model?: string } = {},
): Promise<ChatRow> {
  const data: Record<string, unknown> = { userId }
  if (opts.title !== undefined) data.title = opts.title
  if (opts.model !== undefined) data.model = opts.model
  const result = await executeToolAsApp<{ record: RecordEnvelope<ChatColumns> }>(stub, userId, 'records.create', {
    collection: 'ai-chats',
    data,
  })
  return toChatRow(result.record)
}

/**
 * Patch a chat the caller owns. Returns true if the row was written, false if
 * the chat no longer exists (or never belonged to the caller).
 *
 * The `getChat` precheck is not redundant with the route's own: `records.update`
 * is an upsert on the DO — same code path as create — so an unguarded patch of
 * a chat the user deleted mid-stream *recreates* it as a title-less ghost whose
 * messages are already cascaded away. Writing only over a row that still exists
 * is the one place that can be prevented for every caller, so the guard lives
 * here rather than at each call site. A tiny TOCTOU window remains between the
 * read and the write (closing it needs a compare-and-set on the DO); a delete
 * landing inside that window is the same rare race as before, not the routine
 * "user deleted the chat while the stream ran" case this closes.
 */
export async function updateChat(
  stub: DurableObjectStub,
  chatId: string,
  userId: string,
  patch: Partial<Pick<ChatRow, 'title' | 'model' | 'compactedSummary' | 'compactedThroughId'>>,
): Promise<boolean> {
  if (!(await getChat(stub, chatId, userId))) return false
  await executeToolAsApp(stub, userId, 'records.update', {
    collection: 'ai-chats',
    recordId: chatId,
    data: patch,
  })
  return true
}

/**
 * Messages removed per `records.deleteWhere` call. One subrequest per page,
 * so a chat of any length costs `ceil(messages / PAGE) + 1` subrequests
 * instead of one per message — the old shape ran out of the Workers
 * subrequest budget mid-cascade and orphaned the remainder.
 */
const MESSAGE_DELETE_PAGE = 200

export async function deleteChatCascade(
  stub: DurableObjectStub,
  chatId: string,
  userId: string,
): Promise<void> {
  let messagesError: unknown = null
  try {
    // Each page really removes its rows, so the remaining set strictly shrinks
    // and a short page is the last one.
    let deleted = MESSAGE_DELETE_PAGE
    while (deleted === MESSAGE_DELETE_PAGE) {
      const page = await executeToolAsApp<{ deleted: number }>(stub, userId, 'records.deleteWhere', {
        collection: 'ai-messages',
        where: { chatId },
        limit: MESSAGE_DELETE_PAGE,
      })
      deleted = page.deleted
    }
  } catch (err) {
    messagesError = err
  }

  // Always attempt the chat row delete so the row disappears from listings,
  // even if some message rows got orphaned. If it fails too, its error is the
  // one that surfaces — a chat still sitting in the user's list is the visible
  // failure, orphaned messages are not.
  await executeToolAsApp(stub, userId, 'records.delete', {
    collection: 'ai-chats',
    recordId: chatId,
  })

  if (messagesError) throw messagesError
}

export async function loadMessages(
  stub: DurableObjectStub,
  chatId: string,
  userId: string,
): Promise<ChatMessageRow[]> {
  // Filter by userId in addition to chatId — defense in depth against any
  // future change that lets a row land in this collection without going
  // through the worker (which already verifies chat ownership).
  const result = await executeToolAsApp<{ records: Array<RecordEnvelope<MessageColumns>> }>(stub, userId, 'records.query', {
    collection: 'ai-messages',
    where: { chatId, userId },
    orderBy: 'createdAt',
    orderDir: 'asc',
  })
  return result.records.map(toMessageRow)
}

/**
 * Append one message to a chat the caller owns. Returns true if the row was
 * written, false if the chat is gone (or never belonged to the caller).
 *
 * Same write-after-delete guard as `updateChat`, for the same reason: a turn
 * that finishes after the user deleted the chat would otherwise write messages
 * whose parent row no longer exists — invisible in every listing and never
 * cascaded again.
 */
export async function appendMessage(
  stub: DurableObjectStub,
  msg: {
    id: string
    chatId: string
    userId: string
    role: 'user' | 'assistant' | 'system'
    content: string
    parts?: unknown[]
  },
): Promise<boolean> {
  if (!(await getChat(stub, msg.chatId, msg.userId))) return false
  const data: Record<string, unknown> = {
    chatId: msg.chatId,
    userId: msg.userId,
    role: msg.role,
    content: msg.content,
  }
  if (msg.parts !== undefined) data.parts = msg.parts
  await executeToolAsApp(stub, msg.userId, 'records.create', {
    collection: 'ai-messages',
    recordId: msg.id,
    data,
  })
  return true
}
