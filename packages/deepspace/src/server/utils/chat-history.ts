/**
 * Chat history helpers — wrap RecordRoom's tools API for ai-chats / ai-messages.
 *
 * Trust model: every helper sends `X-App-Action: 'true'`, which bypasses
 * RecordRoom's per-record RBAC. The worker is the trust boundary, not
 * RecordRoom. Callers MUST verify ownership before invoking write helpers
 * (`updateChat`, `appendMessage`, `deleteChatCascade`); the worker's
 * `/api/ai/chat`, `PATCH /api/ai/chats/:id`, and `DELETE /api/ai/chats/:id`
 * routes do this via a `getChat()` precheck that 404s when the row is
 * missing or owned by another user. Read helpers (`getChat`, `loadMessages`)
 * filter by `chatId` against userBound rows, so cross-user reads return
 * empty — but new consumers should still consider an explicit ownership
 * check before exposing data.
 *
 * The tools API returns records as `{ recordId, data, createdAt, updatedAt }`
 * envelopes; helpers below flatten them into ChatRow / ChatMessageRow.
 */

/**
 * Canonical chat row.
 *
 * `recordId` is the primary identifier — same envelope shape as every
 * other DeepSpace data type (records.* tools, useQuery results, etc.).
 *
 * `id` is kept as a deprecated alias so existing callers don't break,
 * but every new caller should prefer `recordId`. Without this rename
 * an integrator who reads `chat.recordId` (the obvious thing given the
 * rest of the SDK) silently gets `undefined`, then ships code that
 * sends `{"chatId": undefined}` to `/api/ai/chat` and gets back a 400
 * with a misleading error.
 */
export type ChatRow = {
  recordId: string
  /** @deprecated Use `recordId`. Retained for backward compatibility. */
  id: string
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
  /** @deprecated Use `recordId`. Retained for backward compatibility. */
  id: string
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

async function executeTool<T>(
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
    // Deprecated alias — populated for back-compat with callers reading `id`.
    id: env.recordId,
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
    // Deprecated alias — populated for back-compat with callers reading `id`.
    id: env.recordId,
    chatId: env.data.chatId,
    userId: env.data.userId,
    role: env.data.role,
    content: env.data.content ?? '',
    parts: env.data.parts,
    createdAt: env.createdAt,
  }
}

export async function getChat(
  stub: DurableObjectStub,
  chatId: string,
  userId: string,
): Promise<ChatRow | null> {
  try {
    const result = await executeTool<{ record: RecordEnvelope<ChatColumns> }>(stub, userId, 'records.get', {
      collection: 'ai-chats',
      recordId: chatId,
    })
    return result.record ? toChatRow(result.record) : null
  } catch (err) {
    if (err instanceof Error && err.message.includes('Record not found')) return null
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
  const result = await executeTool<{ record: RecordEnvelope<ChatColumns> }>(stub, userId, 'records.create', {
    collection: 'ai-chats',
    data,
  })
  return toChatRow(result.record)
}

export async function updateChat(
  stub: DurableObjectStub,
  chatId: string,
  userId: string,
  patch: Partial<Pick<ChatRow, 'title' | 'model' | 'compactedSummary' | 'compactedThroughId'>>,
): Promise<void> {
  await executeTool(stub, userId, 'records.update', {
    collection: 'ai-chats',
    recordId: chatId,
    data: patch,
  })
}

export async function deleteChatCascade(
  stub: DurableObjectStub,
  chatId: string,
  userId: string,
): Promise<void> {
  const list = await executeTool<{ records: Array<RecordEnvelope<MessageColumns>> }>(stub, userId, 'records.query', {
    collection: 'ai-messages',
    where: { chatId },
  })

  const errors: unknown[] = []
  for (const env of list.records) {
    try {
      await executeTool(stub, userId, 'records.delete', {
        collection: 'ai-messages',
        recordId: env.recordId,
      })
    } catch (err) {
      errors.push(err)
    }
  }

  // Always attempt the chat row delete so the row disappears from listings,
  // even if some message rows got orphaned.
  try {
    await executeTool(stub, userId, 'records.delete', {
      collection: 'ai-chats',
      recordId: chatId,
    })
  } catch (err) {
    errors.push(err)
  }

  if (errors.length > 0) {
    const first = errors[0]
    throw new Error(
      `deleteChatCascade: ${errors.length} delete(s) failed; first: ${first instanceof Error ? first.message : String(first)}`,
      { cause: errors },
    )
  }
}

export async function loadMessages(
  stub: DurableObjectStub,
  chatId: string,
  userId: string,
): Promise<ChatMessageRow[]> {
  // Filter by userId in addition to chatId — defense in depth against any
  // future change that lets a row land in this collection without going
  // through the worker (which already verifies chat ownership).
  const result = await executeTool<{ records: Array<RecordEnvelope<MessageColumns>> }>(stub, userId, 'records.query', {
    collection: 'ai-messages',
    where: { chatId, userId },
    orderBy: 'createdAt',
    orderDir: 'asc',
  })
  return result.records.map(toMessageRow)
}

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
): Promise<void> {
  const data: Record<string, unknown> = {
    chatId: msg.chatId,
    userId: msg.userId,
    role: msg.role,
    content: msg.content,
  }
  if (msg.parts !== undefined) data.parts = msg.parts
  await executeTool(stub, msg.userId, 'records.create', {
    collection: 'ai-messages',
    recordId: msg.id,
    data,
  })
}
