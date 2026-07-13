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
import { streamText, stepCountIs } from 'ai'
import type { ModelMessage } from 'ai'
import {
  createDeepSpaceAI,
  prepareMessagesWithCompaction,
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

// Allowlist of models the client may select. Keeps a malicious or stale
// `modelId` from hitting the fallback pricing tier. Add models here as you
// expose them in the UI. When adding a new model, test end-to-end first and
// watch worker logs — reasoning/thinking models occasionally surface chunk
// types we don't handle yet (we ignore them silently in `applyStreamAction`).
//
// IDs use stable aliases (`claude-opus-4-7`) rather than dated snapshots
// (`claude-opus-4-7-20260101`) so a provider's bug-fix release lands here
// without a code change. Pin to a snapshot if you need reproducible behavior.
const ALLOWED_MODELS: Record<string, 'anthropic' | 'openai' | 'cerebras'> = {
  // Anthropic — covers premium ($5/$25), balanced ($3/$15), cheap ($1/$5).
  'claude-opus-4-7':    'anthropic',
  'claude-sonnet-4-6':  'anthropic',
  'claude-haiku-4-5':   'anthropic',
  // OpenAI — chat-completions-compatible only. gpt-5.4-pro exists in the
  // typed model union BUT is Responses-API-only (returns "not a chat model"
  // on /v1/chat/completions). Same restriction applies to o1/o3 today; if
  // we want them, the proxy needs Responses-API support. Until then keep
  // the picker to chat-completions-compatible variants.
  'gpt-5.4':            'openai',
  'gpt-5.4-mini':       'openai',
  'gpt-5.4-nano':       'openai',
  // Cerebras — only `gpt-oss-120b` is on the production tier today
  // (~3000 tok/s). `llama3.1-8b` deprecates 2026-05; preview models
  // (qwen-3-235b, glm-4.7) are explicitly not for production use.
  'gpt-oss-120b':       'cerebras',
}
// Sonnet 4.6 is the balanced default — capable enough for most tool-using
// turns, ~3x cheaper than Opus, and the same 1M-token context.
const DEFAULT_MODEL = 'claude-sonnet-4-6'

function recordRoomStub(env: Env): DurableObjectStub {
  return env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.APP_NAME}`))
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
    await updateChat(stub, id, auth.userId, patch)
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
    // Reject unknown modelId loudly instead of silently falling back to
    // DEFAULT_MODEL. Silent fallback used to hide drift between this
    // allowlist and ChatPanel's DEFAULT_MODELS picker — the dev would see
    // "always Sonnet" output with no clue why.
    if (modelId !== undefined && !ALLOWED_MODELS[modelId]) {
      return c.json({ error: `Unknown modelId: ${modelId}` }, 400)
    }

    const stub = recordRoomStub(c.env)
    const chat = await getChat(stub, chatId, auth.userId)
    if (!chat) {
      console.warn('[ai-chat] REQUEST chat-not-found', { userId: auth.userId, chatId })
      return c.json({ error: 'Chat not found' }, 404)
    }

    // Load history WITHOUT writing the new user row yet — both user and
    // assistant rows are persisted together inside `onFinish` (transactional).
    // If `streamText` errors or the client navigates away, nothing persists,
    // so the DB never accumulates orphan user rows from failed retries.
    const history = await loadMessages(stub, chatId, auth.userId)
    // Carry `parts` through so compaction can truncate stale tool results AND
    // turnsToCoreMessages can rebuild assistant tool-call/tool-result pairs.
    const rawTurns: ChatTurn[] = history.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      parts: m.parts,
    }))

    // Append the in-flight user message in memory so the LLM sees it; the
    // actual DO write happens in onFinish (transactional with the assistant).
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

    // modelId already validated above — fall back to default only when omitted.
    const usedModelId = modelId ?? DEFAULT_MODEL
    const ai = createDeepSpaceAI(c.env, ALLOWED_MODELS[usedModelId], { authToken: jwt })
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

    const result = streamText({
      model: ai(usedModelId),
      system: systemText,
      messages,
      tools,
      // Cap the multi-step tool loop at 5 model calls. v4's `maxSteps: 5` shape;
      // v5 expresses the same thing as a `stopWhen` predicate.
      stopWhen: stepCountIs(5),
      // Propagate the request's AbortSignal so when the client navigates away
      // mid-stream the AI provider call is cancelled and onFinish is skipped —
      // no orphan rows persist, no wasted tokens.
      abortSignal: c.req.raw.signal,
      onError: ({ error }) => {
        console.error('[ai-chat] streamText error:', error)
      },
      onFinish: async ({ text, response }) => {
        const parts = buildUiParts(response.messages as ModelMessage[])
        if (text.trim() === '' && parts.length === 0) {
          console.warn('[ai-chat] FINISH empty turn, skipping persist')
          return
        }

        // Persist user + assistant + metadata together. onFinish fires on stream
        // end (success or post-step abort once at least one step has run); for an
        // abort with zero steps no rows persist. This is the single transactional
        // write point for the turn. Order matters: user FIRST so chronological
        // reads are correct, then assistant. If user-write exhausts retries we
        // ABORT the assistant write — otherwise we'd persist an assistant row
        // with no preceding user row, breaking the invariant relied on by the
        // dedup + turnsToCoreMessages loop on the next turn.
        const writeWithRetry = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
          try { await fn(); return true } catch (err) {
            console.error(`[ai-chat] ${label} failed, retrying once:`, err)
            try { await fn(); return true } catch (retryErr) {
              console.error(`[ai-chat] ${label} retry failed:`, retryErr)
              return false
            }
          }
        }

        const userOk = await writeWithRetry('user message', () => appendMessage(stub, {
          id: userMessageId,
          chatId,
          userId: auth.userId,
          role: 'user',
          content,
        }))
        if (!userOk) {
          console.error('[ai-chat] FINISH aborting — user write failed; skipping assistant + metadata to avoid orphan rows')
          return
        }
        await writeWithRetry('assistant message', () => appendMessage(stub, {
          id: asstId,
          chatId,
          userId: auth.userId,
          role: 'assistant',
          content: text,
          ...(parts.length > 0 ? { parts } : {}),
        }))
        await writeWithRetry('chat metadata', async () => {
          // Re-fetch so a mid-stream rename by the user isn't clobbered by a
          // stale "auto-title" derived from the captured `chat` snapshot.
          // (Note: a tiny TOCTOU window remains between this getChat and the
          // updateChat below — accepted as low-impact; would need a CAS API
          // on the DO to fully close.)
          const fresh = await getChat(stub, chatId, auth.userId)
          const patch: { title?: string; model?: string } = { model: usedModelId }
          if (fresh && (!fresh.title || fresh.title === 'New chat')) {
            patch.title = deriveTitle(content)
          }
          await updateChat(stub, chatId, auth.userId, patch)
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
