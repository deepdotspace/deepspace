/**
 * Chat context pipeline — keeps the per-request payload to the LLM bounded.
 *
 * `prepareMessagesWithCompaction` runs before `streamText`: truncate old tool
 * results, apply a cached summary if available, otherwise summarize the older
 * half of history when over budget. Falls back to a sliding window if
 * summarization fails. `capToolResultSize` caps individual tool calls.
 */

import { generateText, type ModelMessage } from 'ai'
import { createDeepSpaceAI, type DeepSpaceAIEnv } from './ai'

export interface ChatTurn {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  parts?: unknown[]
}

export type Summarizer = (messages: ChatTurn[]) => Promise<string>

export interface ChatContextConfig {
  contextBudget: number
  toolResultCap: number
  keepRecentToolResults: number
  minKept: number
}

// contextBudget: 240_000 chars ≈ 60-80K tokens of history.
// Safe for 200K+ context models (Claude Sonnet/Opus, GPT-4.1/4o).
// If your app uses a 128K-context model, lower to ~120_000.
// If your app uses a 32K-context model (some open-weight Cerebras models),
// lower to ~40_000.
export const DEFAULT_CONTEXT_CONFIG: ChatContextConfig = {
  contextBudget: 240_000,
  toolResultCap: 30_000,
  keepRecentToolResults: 5,
  minKept: 10,
}

function sizeOf(m: ChatTurn): number {
  return (m.content ?? '').length + (m.parts ? JSON.stringify(m.parts).length : 0)
}

export function totalChars(messages: ChatTurn[]): number {
  return messages.reduce((acc, m) => acc + sizeOf(m), 0)
}

/**
 * Replace older tool-result payloads with a small marker. Keeps the last
 * `keepRecent` tool results intact. Errors (`success: false`) are preserved —
 * they're small and the agent needs them for reasoning.
 */
export function truncateOldToolResults(messages: ChatTurn[], keepRecent: number): ChatTurn[] {
  const assistantIdxs: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') assistantIdxs.push(i)
  }
  const protectedStart =
    assistantIdxs.length > keepRecent ? assistantIdxs[assistantIdxs.length - keepRecent] : 0

  return messages.map((msg, idx) => {
    if (msg.role !== 'assistant' || idx >= protectedStart) return msg
    if (!Array.isArray(msg.parts) || msg.parts.length === 0) return msg
    const newParts = msg.parts.map((p) => {
      if (!p || typeof p !== 'object') return p
      const anyP = p as Record<string, unknown>
      if (anyP.type !== 'tool-invocation') return p
      const inv = anyP.toolInvocation as Record<string, unknown> | undefined
      if (!inv || inv.state !== 'result') return p
      const result = inv.result as Record<string, unknown> | undefined
      if (result && result.success === false) return p
      return {
        ...anyP,
        toolInvocation: {
          ...inv,
          result: {
            _truncated: true,
            note: 'Result from an earlier turn omitted to save context. Call this tool again if you need the data.',
          },
        },
      }
    })
    return { ...msg, parts: newParts }
  })
}

/**
 * Drop oldest messages until total character count is under `charCap`,
 * never going below `minKept` messages. System messages (e.g. compaction
 * summaries) are pinned — dropping them would discard the most condensed
 * context first.
 */
export function applySlidingWindow(
  messages: ChatTurn[],
  charCap: number,
  minKept: number,
): ChatTurn[] {
  let total = totalChars(messages)
  if (total <= charCap) return messages
  const out = [...messages]
  while (out.length > minKept && total > charCap) {
    const idx = out.findIndex((m) => m.role !== 'system')
    if (idx < 0) break
    const dropped = out.splice(idx, 1)[0]
    total -= sizeOf(dropped)
  }
  return out
}

type ResultObj = Record<string, unknown>

// Paths (root → array) we know how to trim, in priority order. Covers the
// built-in tool-result shapes: `{ records: [...] }`, `{ data: { records } }`,
// and a bare `{ data: [...] }`.
const TRIMMABLE_ARRAY_PATHS: string[][] = [
  ['records'],
  ['data', 'records'],
  ['items'],
  ['data', 'items'],
  ['data'],
]

function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as ResultObj)[key]
  }
  return cur
}

// Shallow-clone along `path`, set the leaf to `value`, and merge `flags` into
// the object that directly holds the leaf. Non-mutating — the original result
// is untouched.
function setPath(root: unknown, path: string[], value: unknown, flags: ResultObj): unknown {
  const obj = root && typeof root === 'object' ? (root as ResultObj) : {}
  const [head, ...tail] = path
  if (tail.length === 0) {
    return { ...obj, [head]: value, ...flags }
  }
  return { ...obj, [head]: setPath(obj[head], tail, value, flags) }
}

// Find the first trimmable array in a tool result, so an oversized payload can
// be degraded to a usable prefix instead of discarded. Returns undefined when
// the payload carries no array we know how to shorten.
function locateTrimmableArray(result: ResultObj): { path: string[]; items: unknown[] } | undefined {
  for (const path of TRIMMABLE_ARRAY_PATHS) {
    const arr = getPath(result, path)
    if (Array.isArray(arr)) return { path, items: arr }
  }
  // Generic fallbacks: first array prop at the top level, then one level into `data`.
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) return { path: [key], items: value }
  }
  const data = result.data
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data as ResultObj)) {
      if (Array.isArray(value)) return { path: ['data', key], items: value }
    }
  }
  return undefined
}

/**
 * Keep an individual tool result under `byteCap`.
 *
 * If the payload carries a list of items (e.g. a `records.query` result), it is
 * degraded gracefully: as many leading items as fit under the cap are returned,
 * the `success: true` shape is preserved, and `{ truncated, returned, total }`
 * flags are merged in next to the array so callers can still use the partial
 * data and paginate for the rest.
 *
 * Only when there is no array to trim (or even an empty list still overflows
 * because of oversized sibling fields) does it fall back to replacing the
 * result with an error + small preview telling the agent to narrow its query.
 */
export function capToolResultSize(result: unknown, byteCap: number): unknown {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(result)
  } catch {
    return { success: false, error: 'Tool result could not be serialized.' }
  }
  // JSON.stringify returns `undefined` (not a string) for `undefined`,
  // bare functions, and symbols. Pass those through — caller decides what
  // to do with non-serializable shapes; this function's job is only to
  // cap oversized payloads.
  if (typeof serialized !== 'string') return result
  if (serialized.length <= byteCap) return result

  if (result && typeof result === 'object') {
    const located = locateTrimmableArray(result as ResultObj)
    if (located) {
      const { path, items } = located
      const total = items.length
      const build = (k: number) =>
        setPath(result, path, items.slice(0, k), { truncated: true, returned: k, total })
      const fits = (k: number): boolean => {
        try {
          return JSON.stringify(build(k)).length <= byteCap
        } catch {
          return false
        }
      }
      // Only degrade if an empty list actually fits — otherwise the bloat is in
      // sibling fields, not the array, and trimming it can't help.
      if (fits(0)) {
        // Binary search for the largest prefix that still fits under the cap.
        let lo = 0
        let hi = total
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2)
          if (fits(mid)) lo = mid
          else hi = mid - 1
        }
        // Return a partial page only if at least one item fits. When not even a
        // single record fits (one oversized record), fall through to the error
        // below so the caller gets actionable guidance instead of an empty list
        // that reads like "no results".
        if (lo > 0) return build(lo)
      }
    }
  }

  return {
    success: false,
    truncated: true,
    error:
      `Tool result exceeded ${byteCap} bytes (was ${serialized.length}). ` +
      `Retry with a narrower query (e.g. add a \`where\` filter, reduce \`limit\`, ` +
      `or call records.get for a single record).`,
    preview: serialized.slice(0, 2_000),
  }
}

/**
 * Convert persisted ChatTurns into AI SDK ModelMessages.
 *
 * Persisted assistant rows store `parts` in UI shape (text + tool-invocation,
 * each invocation carrying its own `result`). When fed back to the LLM, the
 * shape MUST match the original multi-step flow: an assistant message
 * containing a `tool_use` block must end with that block, the IMMEDIATELY
 * NEXT message must be a tool/user message containing the matching
 * `tool_result`, and any text the model produced AFTER seeing the tool
 * result belongs in a SEPARATE assistant message after the tool message.
 *
 * Anthropic specifically rejects an assistant message of the form
 * `[text, tool_use, text]` — the trailing text breaks its `tool_use` →
 * `tool_result` pairing check. So we walk the parts in order and split at
 * each tool-invocation boundary, emitting a fresh assistant + tool pair per
 * tool call, and a final trailing assistant message for any post-tool text.
 *
 * Tool-invocation entries with `state: 'call'` (no result — typically an
 * interrupted stream) are dropped on both sides.
 */
export function turnsToCoreMessages(turns: ChatTurn[]): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const t of turns) {
    if (t.role === 'system') {
      out.push({ role: 'system', content: t.content })
      continue
    }
    if (t.role === 'user') {
      out.push({ role: 'user', content: t.content })
      continue
    }

    if (!Array.isArray(t.parts) || t.parts.length === 0) {
      if (t.content) out.push({ role: 'assistant', content: t.content })
      continue
    }

    // Persisted ChatTurn parts use a flat `args`/`result` shape; the SDK
    // wants v5's `input` and `output: { type:'json', value }` wrapper. The
    // `json` tag is the right variant for JSON-serializable tool results.
    type AssistantPart =
      | { type: 'text'; text: string }
      | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
    type ToolResultEntry = {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      output: { type: 'json'; value: unknown }
    }

    // Pending text segment + the tool call it terminates with (if any).
    let pending: AssistantPart[] = []
    let emittedAny = false

    const flushAssistant = () => {
      if (pending.length === 0) return
      out.push({ role: 'assistant', content: pending } as ModelMessage)
      pending = []
      emittedAny = true
    }

    for (const p of t.parts) {
      if (!p || typeof p !== 'object') continue
      const anyP = p as Record<string, unknown>
      if (anyP.type === 'text' && typeof anyP.text === 'string' && anyP.text) {
        pending.push({ type: 'text', text: anyP.text })
        continue
      }
      if (anyP.type !== 'tool-invocation') continue
      const inv = anyP.toolInvocation as Record<string, unknown> | undefined
      const toolCallId = typeof anyP.toolCallId === 'string' ? anyP.toolCallId : undefined
      const toolName = typeof inv?.toolName === 'string' ? (inv.toolName as string) : undefined
      if (!toolCallId || !toolName) continue
      // Drop calls without a paired result — AI SDK errors on unanswered calls.
      if (inv?.state !== 'result') continue

      // Close out the current assistant segment with the tool_use block, then
      // emit it followed by a tool message holding the matching tool_result.
      pending.push({ type: 'tool-call', toolCallId, toolName, input: inv?.args })
      flushAssistant()
      const tr: ToolResultEntry = {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'json', value: inv.result as unknown },
      }
      out.push({ role: 'tool', content: [tr] } as ModelMessage)
    }

    // Trailing text after the last tool call (or the whole turn if no tools).
    flushAssistant()

    // Fallback: turn had only orphan tool-calls (all state:'call'); use plain
    // content text so we don't drop the message entirely.
    if (!emittedAny && t.content) {
      out.push({ role: 'assistant', content: t.content })
    }
  }

  return out
}

/**
 * Convert AI SDK response messages into our persisted UI shape (text +
 * tool-invocation parts), pairing each assistant tool-call with its tool-
 * result from the following tool message. Order is chronological.
 *
 * Inverse of `turnsToCoreMessages`: takes the v5 `ModelMessage[]` returned
 * from `streamText`'s `onFinish` and produces the flat `parts` array we
 * persist on `ai-messages` rows. Reads `c.input` / `c.output` (v5 wire
 * names) and unwraps `output`'s tagged-union via `unwrapToolOutput`.
 */
export function buildUiParts(responseMessages: ModelMessage[]): unknown[] {
  const toolResults = new Map<string, unknown>()
  for (const msg of responseMessages) {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
    for (const c of msg.content) {
      if (c.type === 'tool-result') {
        toolResults.set(c.toolCallId, unwrapToolOutput(c.output))
      }
    }
  }
  const parts: unknown[] = []
  for (const msg of responseMessages) {
    if (msg.role !== 'assistant') continue
    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ type: 'text', text: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue
    for (const c of msg.content) {
      if (c.type === 'text' && typeof c.text === 'string' && c.text) {
        parts.push({ type: 'text', text: c.text })
      } else if (c.type === 'tool-call') {
        const result = toolResults.get(c.toolCallId)
        if (result === undefined) {
          // onFinish only fires on a successful stream, so every tool-call
          // should have a paired tool-result. If one is missing (provider
          // quirk, mid-step failure), drop the half-state invocation —
          // turnsToCoreMessages would drop it on the next turn anyway.
          continue
        }
        parts.push({
          type: 'tool-invocation',
          toolCallId: c.toolCallId,
          toolInvocation: {
            toolName: c.toolName,
            state: 'result',
            args: c.input,
            result,
          },
        })
      }
    }
  }
  return parts
}

/**
 * Unwrap v5's tagged tool-result `output` to the flat shape we persist.
 * Errors get remapped to `{ success: false, error }` because
 * `truncateOldToolResults` preserves entries with that shape across turns —
 * without the remap, error context would get truncated like a normal result.
 */
export function unwrapToolOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output
  const o = output as Record<string, unknown>
  const tag = typeof o.type === 'string' ? o.type : null
  if (tag === 'json' || tag === 'text') {
    return 'value' in o ? o.value : output
  }
  if (tag === 'error-text' || tag === 'error-json') {
    return { success: false, error: 'value' in o ? o.value : 'Tool execution failed' }
  }
  return output
}

function buildSummaryMessage(text: string, throughId: string): ChatTurn {
  return {
    id: `summary-${throughId}`,
    role: 'system',
    content: `Earlier conversation summary:\n${text}`,
  }
}

/**
 * Pre-stream pipeline with compaction.
 *
 * 1. Truncate old tool results.
 * 2. If a cached summary covers a known message id, replace prior turns with it.
 * 3. If still over budget, summarize the older half of `working` and return a
 *    `newSummary` for persistence — runs even after cached-summary application
 *    so a long-running chat can re-summarize on subsequent turns.
 * 4. On summarizer error or missing ids, fall back to a sliding window
 *    (which preserves system messages — see `applySlidingWindow`).
 */
export async function prepareMessagesWithCompaction(
  messages: ChatTurn[],
  config: ChatContextConfig,
  options: {
    summarizer: Summarizer
    cachedSummary?: { text: string; throughId: string }
  },
): Promise<{ messages: ChatTurn[]; newSummary?: { text: string; throughId: string } }> {
  const truncated = truncateOldToolResults(messages, config.keepRecentToolResults)

  let working = truncated
  if (options.cachedSummary) {
    const idx = truncated.findIndex((m) => m.id === options.cachedSummary!.throughId)
    if (idx >= 0) {
      working = [
        buildSummaryMessage(options.cachedSummary.text, options.cachedSummary.throughId),
        ...truncated.slice(idx + 1),
      ]
    }
  }

  if (totalChars(working) <= config.contextBudget) {
    return { messages: working }
  }

  // Over budget: summarize the older half of `working`. Runs even when a
  // cached summary was applied — the summarizer prompt rolls prior summaries
  // forward, so the fresh summary subsumes the old one.
  const half = Math.max(1, Math.floor(working.length / 2))
  const older = working.slice(0, half)
  const newer = working.slice(half)
  // Pick the last REAL message id in `older` as the anchor. A previously
  // applied cached summary leaves a synthetic `summary-...` id at index 0;
  // anchoring on it would round-trip through history (which has no such id)
  // and force a re-summarize from scratch every turn — a billing leak.
  let throughId: string | undefined
  for (let i = older.length - 1; i >= 0; i--) {
    const id = older[i].id
    if (id && !id.startsWith('summary-')) {
      throughId = id
      break
    }
  }
  if (throughId) {
    try {
      const text = await options.summarizer(older)
      return {
        messages: [buildSummaryMessage(text, throughId), ...newer],
        newSummary: { text, throughId },
      }
    } catch (err) {
      console.error('prepareMessagesWithCompaction: summarizer failed, falling back to sliding window', err)
    }
  } else {
    console.warn('prepareMessagesWithCompaction: messages lack ids; cannot anchor a summary, falling back to sliding window')
  }

  return {
    messages: applySlidingWindow(working, config.contextBudget, config.minKept),
  }
}

const SUMMARIZER_SYSTEM_PROMPT = `You are compressing a conversation between a user and an AI assistant into a
concise memory summary. The summary will replace the original messages in the
conversation history; the assistant will read it on subsequent turns to
maintain continuity.

Preserve in the summary:
- User preferences and constraints the user stated (coding style, tone,
  skill level, goals).
- Decisions made and rejected alternatives ("we chose X over Y because Z").
- Current task state (what's in progress, what's been completed).
- Any facts the user might reasonably reference later.

If the messages below contain a prior summary, incorporate its content into
your new summary — do not drop information from earlier summaries.

Keep the summary under 2000 tokens. Write as a factual note to future-you,
not as a narrative. Use terse bullet points where possible.`

function formatTranscript(messages: ChatTurn[]): string {
  return messages
    .map((m) => {
      const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System'
      const tools = Array.isArray(m.parts)
        ? m.parts
            .filter((p) => (p as { type?: string } | null)?.type === 'tool-invocation')
            .map((p) => {
              const name = (p as { toolInvocation?: { toolName?: string } }).toolInvocation?.toolName
              return `  [tool: ${name ?? 'unknown'}]`
            })
            .join('\n')
        : ''
      return `${label}: ${m.content}${tools ? '\n' + tools : ''}`
    })
    .join('\n\n')
}

/**
 * Build a default summarizer backed by Claude Haiku.
 *
 * Billing: defaults to the app owner via `APP_OWNER_JWT` — summarization is
 * usually infrastructure, not user work. Pass `{ authToken }` to bill a
 * specific user (e.g. the caller's JWT) instead.
 */
export function makeDefaultSummarizer(
  env: DeepSpaceAIEnv,
  options: { authToken?: string } = {},
): Summarizer {
  return async (messages) => {
    const anthropic = createDeepSpaceAI(env, 'anthropic', { authToken: options.authToken })
    const { text } = await generateText({
      // Stable alias — provider bug-fix snapshots roll forward without code change.
      model: anthropic('claude-haiku-4-5'),
      // 2500 gives the model room to finish a sentence after hitting the
      // "under 2000 tokens" soft limit in the prompt.
      maxOutputTokens: 2500,
      system: SUMMARIZER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: formatTranscript(messages) }],
    })
    return text
  }
}
