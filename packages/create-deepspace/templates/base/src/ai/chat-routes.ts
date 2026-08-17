/**
 * AI chat routes — multi-turn tool-use via Vercel AI SDK + DeepSpace proxy.
 *
 * Registers four endpoints on the passed-in Hono app:
 *   POST   /api/ai/chats       — create a chat owned by the caller
 *   PATCH  /api/ai/chats/:id   — rename / patch a chat
 *   DELETE /api/ai/chats/:id   — delete chat + cascade messages
 *   POST   /api/ai/chat        — streamed assistant turn (the big one)
 *
 * Lives in its own file so worker.ts can stay small and the streaming
 * handler's full context (compaction, tools, persistence, abort handling)
 * is co-located rather than scattered through the entry file.
 */

import type { Hono } from 'hono'
import type { ModelMessage } from 'ai'
import {
  deepSpaceAgentErrorSummary,
  prepareMessagesWithCompaction,
  listDeepSpaceAgentModels,
  resolveDeepSpaceAgentModel,
  streamDeepSpaceAgent,
  turnsToCoreMessages,
  buildUiParts,
  makeDefaultSummarizer,
  capToolResultSize,
  DEFAULT_CONTEXT_CONFIG,
  getChat,
  createChat,
  updateChat,
  deleteChatCascade,
  loadMessages,
  appendMessage,
} from 'deepspace/worker'
import type { ChatTurn, VerifyResult } from 'deepspace/worker'
import { schemas } from '../schemas.js'
import { buildSystemPrompt, buildTools } from './tools.js'
// Type-only — TypeScript strips these at runtime, so no circular import
// with worker.ts (which imports `registerAiChatRoutes` from this file).
import type { Env, AppContext } from '../../worker.js'

type ResolveAuth = (req: Request, env: Env) => Promise<VerifyResult | null>

function recordRoomStub(env: Env): DurableObjectStub {
  // Rooms are keyed by the immutable app id — the same `app:${DEEPSPACE_APP_ID}`
  // the client's RecordScope (SCOPE_ID) and worker.ts's own stubs use. Keying
  // by APP_NAME would read/write a room the browser never subscribes to.
  return env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))
}

// Cap on user-supplied content length. Far above any realistic message;
// blocks accidental DoS via megabyte payloads.
const MAX_USER_CONTENT_LENGTH = 100_000

// Derive a chat title from the first user message — first non-empty line,
// trimmed to ~50 chars with an ellipsis.
function deriveTitle(content: string): string {
  const first = content.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? 'Untitled'
  return first.length <= 50 ? first : first.slice(0, 47).trimEnd() + '…'
}

export function registerAiChatRoutes(
  app: Hono<AppContext>,
  resolveAuth: ResolveAuth,
): void {
  // Create a new chat row owned by the caller.
  app.post('/api/ai/chats', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'Unauthorized' }, 401)

    const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }))
    const stub = recordRoomStub(c.env)
    const chat = await createChat(stub, auth.userId, {
      title: body.title ?? 'New chat',
    })
    return c.json({ chat })
  })

  // Rename / patch a chat. Ownership enforced via getChat.
  app.patch('/api/ai/chats/:id', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const stub = recordRoomStub(c.env)
    const chat = await getChat(stub, id, auth.userId)
    if (!chat) return c.json({ error: 'Not found' }, 404)

    const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }))
    const patch: { title?: string } = {}
    if (typeof body.title === 'string') patch.title = body.title
    // `updateChat` re-checks the chat; a delete racing this PATCH answers 404
    // instead of `ok: true` for a write that never landed.
    if (!(await updateChat(stub, id, auth.userId, patch))) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true })
  })

  // Delete chat + cascade messages.
  app.delete('/api/ai/chats/:id', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const stub = recordRoomStub(c.env)
    const chat = await getChat(stub, id, auth.userId)
    if (!chat) return c.json({ error: 'Not found' }, 404)

    await deleteChatCascade(stub, id, auth.userId)
    return c.json({ ok: true })
  })

  // Known limitation: two tabs sending to the same chatId concurrently can
  // interleave row writes (DO serializes individual writes but not the
  // per-request 3-write group). The next turn's history then mis-pairs
  // user/assistant rows. Closing this requires per-chatId locking in the DO;
  // out of scope for this PR. Realistic impact: rare (multi-tab same-chat
  // usage); recoverable by user (one tab works correctly going forward).
  app.post('/api/ai/chat', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'Unauthorized' }, 401)

    const authHeader = c.req.header('Authorization') ?? ''
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!jwt) return c.json({ error: 'Unauthorized' }, 401)

    const { chatId, userMessageId, content, modelId } = await c.req.json<{
      chatId?: string
      userMessageId?: string
      content?: string
      modelId?: string
    }>()
    if (typeof chatId !== 'string' || !chatId) return c.json({ error: 'chatId is required' }, 400)
    if (typeof userMessageId !== 'string' || !userMessageId) return c.json({ error: 'userMessageId is required' }, 400)
    if (typeof content !== 'string' || content.trim() === '') return c.json({ error: 'content is required' }, 400)
    if (content.length > MAX_USER_CONTENT_LENGTH) {
      return c.json({ error: `content exceeds ${MAX_USER_CONTENT_LENGTH} chars` }, 413)
    }
    const selectedModel = resolveDeepSpaceAgentModel(modelId, 'application')
    if (!selectedModel) {
      // Name the valid ids: the caller has no other way to learn them here.
      const modelIds = listDeepSpaceAgentModels('application').map((model) => model.id)
      return c.json(
        { error: `Unknown modelId: ${modelId}. Valid: ${modelIds.join(', ')}`, code: 'unknown_model', modelIds },
        400,
      )
    }

    const stub = recordRoomStub(c.env)
    const chat = await getChat(stub, chatId, auth.userId)
    if (!chat) {
      console.warn('[ai-chat] REQUEST chat-not-found', { userId: auth.userId, chatId })
      return c.json({ error: 'Chat not found' }, 404)
    }

    // Load history before writing this turn. `onFinish` later writes user then
    // assistant as separate DO operations; the ordering is intentional, but
    // it is not atomic.
    const history = await loadMessages(stub, chatId, auth.userId)
    // Carry `parts` through so compaction can truncate stale tool results AND
    // turnsToCoreMessages can rebuild assistant tool-call/tool-result pairs.
    const rawTurns: ChatTurn[] = history.map((m) => ({
      id: m.recordId,
      role: m.role,
      content: m.content,
      parts: m.parts,
    }))

    // Append the in-flight user message in memory so the LLM sees it; its DO
    // write is the first persistence operation in `onFinish`.
    // Then dedup consecutive user messages — defense-in-depth for legacy
    // chats with orphan user rows AND for the rare case where a prior turn's
    // user-write succeeded but the assistant-write failed both retries.
    // Crucial: dedup runs AFTER appending the in-flight; otherwise a trailing
    // orphan user from history would survive the loop (no following user in
    // raw history) and then sit next to the in-flight user, sending two
    // consecutive user messages to the LLM.
    const allTurns: ChatTurn[] = [...rawTurns, { id: userMessageId, role: 'user', content }]
    const turns: ChatTurn[] = []
    for (let i = 0; i < allTurns.length; i++) {
      if (allTurns[i].role === 'user' && allTurns[i + 1]?.role === 'user') continue
      turns.push(allTurns[i])
    }

    const cachedSummary = chat.compactedSummary && chat.compactedThroughId
      ? { text: chat.compactedSummary, throughId: chat.compactedThroughId }
      : undefined

    // User-billed: compaction is part of the user's chat experience, not infra.
    const summarizer = makeDefaultSummarizer(c.env, { authToken: jwt })
    const { messages: prepared, newSummary } = await prepareMessagesWithCompaction(
      turns,
      DEFAULT_CONTEXT_CONFIG,
      { summarizer, cachedSummary },
    )
    if (newSummary) {
      await updateChat(stub, chatId, auth.userId, {
        compactedSummary: newSummary.text,
        compactedThroughId: newSummary.throughId,
      })
    }

    const usedModelId = selectedModel.modelId
    const diagnosticContext = {
      profile: 'application' as const,
      provider: selectedModel.provider,
      modelId: usedModelId,
    }
    const baseSystem = buildSystemPrompt(c.env.APP_NAME, schemas)

    // Compaction inserts at most one summary system message at index 0; fold
    // it into the top-level `system` so we don't pass two system roles. Then
    // convert the remaining ChatTurns into AI SDK ModelMessages — splitting
    // assistant rows into the assistant + paired tool messages the SDK expects.
    const [first, ...rest] = prepared
    const summary = first?.role === 'system' ? first : null
    const systemText = summary ? `${baseSystem}\n\n${summary.content}` : baseSystem
    const messages = turnsToCoreMessages(summary ? rest : prepared)

    const tools = buildTools(async (toolName, params) => {
      const res = await stub.fetch(new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': auth.userId,
        },
        body: JSON.stringify({ tool: toolName, params }),
        // Forward the route's abort signal so a tool fetch in flight is
        // cancelled if the client navigates away mid-stream — without this,
        // the LLM stream cancels but the per-tool DO call runs to completion.
        signal: c.req.raw.signal,
      }))
      const raw = await res.json()
      return capToolResultSize(raw, DEFAULT_CONTEXT_CONFIG.toolResultCap)
    })

    // Allocate the assistant row id BEFORE streaming starts so we can echo it
    // back via a response header. The client tags its in-flight overlay with
    // this id and dedups against the WebSocket-broadcast persisted row by id —
    // not by comparing `spawnTime` (client clock) to `createdAt` (server clock),
    // which broke for users whose clock was ahead of the server.
    const asstId = `asst-${Date.now()}-${crypto.randomUUID()}`

    const { result } = streamDeepSpaceAgent(c.env, {
      profile: 'application',
      modelId: usedModelId,
      authToken: jwt,
      system: systemText,
      messages,
      tools,
      // Cancel provider and tool work with the request. If at least one step
      // completed, AI SDK still calls `onFinish`; a zero-step abort skips it.
      abortSignal: c.req.raw.signal,
      onError: ({ error }) => {
        console.error(
          `[ai-chat] stream error: ${deepSpaceAgentErrorSummary(error, diagnosticContext)}`,
        )
      },
      onFinish: async ({ text, response }) => {
        const parts = buildUiParts(response.messages as ModelMessage[])
        if (text.trim() === '' && parts.length === 0) {
          console.warn('[ai-chat] FINISH empty turn, skipping persist')
          return
        }

        // Persist user → assistant → metadata as independent writes, not a
        // transaction. `onFinish` runs after normal completion and after an
        // abort with at least one completed step. Order matters: user FIRST so
        // chronological reads are correct, then assistant. If user-write
        // exhausts retries we ABORT the assistant write — otherwise we'd persist
        // an assistant row with no preceding user row, breaking the invariant
        // relied on by the dedup + turnsToCoreMessages loop on the next turn.
        //
        // The helpers return `false` (no throw) when the chat no longer exists
        // — deleted mid-stream — and nothing was written; that is not retried,
        // and it stops the sequence the same way an exhausted retry does.
        const writeWithRetry = async (label: string, fn: () => Promise<boolean | void>): Promise<boolean> => {
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              if ((await fn()) === false) {
                console.warn(`[ai-chat] ${label} skipped — chat ${chatId} no longer exists`)
                return false
              }
              return true
            } catch (err) {
              console.error(`[ai-chat] ${label} ${attempt === 1 ? 'failed, retrying once' : 'retry failed'}:`, err)
            }
          }
          return false
        }

        const userOk = await writeWithRetry('user message', () => appendMessage(stub, {
          id: userMessageId,
          chatId,
          userId: auth.userId,
          role: 'user',
          content,
        }))
        if (!userOk) {
          console.error('[ai-chat] FINISH aborting — user write did not land; skipping assistant + metadata to avoid orphan rows')
          return
        }
        const assistantOk = await writeWithRetry('assistant message', () => appendMessage(stub, {
          id: asstId,
          chatId,
          userId: auth.userId,
          role: 'assistant',
          content: text,
          ...(parts.length > 0 ? { parts } : {}),
        }))
        if (!assistantOk) return
        await writeWithRetry('chat metadata', async () => {
          // Re-fetch so a mid-stream rename by the user isn't clobbered by a
          // stale "auto-title" derived from the captured `chat` snapshot. A
          // chat deleted mid-stream reads back as null; `updateChat` refuses
          // that case on its own (an unguarded `records.update` would upsert
          // the row back into existence), so this only decides the title.
          const fresh = await getChat(stub, chatId, auth.userId)
          const patch: { title?: string; model?: string } = { model: usedModelId }
          if (fresh && (!fresh.title || fresh.title === 'New chat')) {
            patch.title = deriveTitle(content)
          }
          return updateChat(stub, chatId, auth.userId, patch)
        })
      },
    })

    return result.toUIMessageStreamResponse({
      headers: {
        // Lets the client tag its in-flight assistant overlay with the same id
        // the worker will use when persisting on `onFinish`, so dedup against
        // the WebSocket-broadcast row is by id (clock-skew-proof).
        'X-Asst-Id': asstId,
      },
      // Reasoning models (o-series, Claude with extended thinking) emit
      // `reasoning-start`/`reasoning-delta`/`reasoning-end` chunks. We
      // don't render them today — pass them through and the user sees a
      // stuck spinner during long thinks. Opt out at the boundary until
      // the UI gains a "thinking" disclosure block.
      sendReasoning: false,
      onError: (error: unknown): string => {
        // The return value becomes the user-visible `errorText` for every
        // `tool-input-error` / `tool-output-error` chunk and stream-level
        // error. Surface the real message so RBAC denials and validation
        // failures are debuggable; log full detail server-side.
        console.error('[ai-chat] response error:', error)
        return error instanceof Error ? error.message : String(error)
      },
    })
  })
}
