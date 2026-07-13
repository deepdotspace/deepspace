/**
 * Pure decoders for the Vercel AI SDK v5 `toUIMessageStreamResponse` body.
 *
 * The wire format is SSE: each event is `data: <json>\n\n`, terminated by
 * `data: [DONE]\n\n`. Each event carries a `type` discriminator
 * (`text-delta`, `tool-input-available`, `tool-output-available`,
 * `tool-input-error`, `tool-output-error`, `error`, `abort`, …) — see the
 * `UIMessageChunk` union in `ai/dist/index.d.ts`.
 *
 * This module decodes those chunks into a small action vocabulary that
 * the React layer then applies to its state. Keeping decode pure means
 * the v5-boundary behavior is fully testable without spinning up a
 * component tree.
 */

/** Raw v5 stream chunk, as parsed off the wire. `type` may be any string. */
export type AiStreamChunk = Record<string, unknown> & { type?: unknown }

/**
 * Strip one SSE line's framing. Returns the parsed JSON payload, or `null`
 * for blank lines, comment lines (`:` prefix), non-`data:` SSE fields, the
 * `[DONE]` terminator, or any line whose payload doesn't parse as JSON.
 *
 * Multi-line `data:` events (per the SSE spec, joined by `\n` before
 * dispatch) are NOT supported — v5's emitter never produces them. If you
 * hit a wire intermediary that re-splits long payloads (e.g. a proxy that
 * caps line length), upgrade this to accumulate consecutive `data:` lines
 * until a blank line.
 */
export function parseSseLine(line: string): AiStreamChunk | null {
  if (!line) return null
  if (line.startsWith(':')) return null // SSE comment
  if (!line.startsWith('data:')) return null // we only consume `data:` events
  // SSE allows exactly one space after the colon to be elided. Trim a
  // trailing \r so CRLF-framed responses still hit the [DONE] short-circuit.
  const raw = line.slice(5).replace(/^ /, '').replace(/\r$/, '')
  if (raw === '[DONE]') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as AiStreamChunk
  } catch {
    return null
  }
}

/**
 * Action vocabulary the React layer applies. Every `decodeAiStreamChunk`
 * output is one of these — `null` means the chunk is intentionally ignored
 * (lifecycle markers, reasoning we don't surface yet, etc.).
 *
 * Wire field renames (v5): chunks carry `input` / `output` directly. We
 * map them to `args` / `result` here so persisted UI shapes stay v4-stable.
 */
export type AiStreamAction =
  | { type: 'append-text'; delta: string }
  | { type: 'upsert-tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'finalize-tool-call'; toolCallId: string; result: unknown }
  /**
   * Schema validation rejected the input before the tool ran; no preceding
   * `upsert-tool-call` was emitted, so the React layer must create the
   * invocation and finalize it as failed in one step.
   */
  | { type: 'fail-tool-input'; toolCallId: string; toolName: string; input: unknown; errorText: string }
  /** Tool execution failed; a previous `upsert-tool-call` exists to finalize. */
  | { type: 'fail-tool-output'; toolCallId: string; errorText: string }
  | { type: 'stream-error'; errorText: string }
  /** Server-side abort with no error chunk to follow. */
  | { type: 'abort' }

/** Decode one v5 UIMessage stream chunk into an action, or `null` to ignore. */
export function decodeAiStreamChunk(chunk: AiStreamChunk): AiStreamAction | null {
  if (typeof chunk.type !== 'string') return null

  switch (chunk.type) {
    case 'text-delta': {
      const delta = typeof chunk.delta === 'string' ? chunk.delta : ''
      if (!delta) return null
      return { type: 'append-text', delta }
    }

    case 'tool-input-available': {
      if (typeof chunk.toolCallId !== 'string' || typeof chunk.toolName !== 'string') return null
      return {
        type: 'upsert-tool-call',
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
      }
    }

    case 'tool-output-available': {
      if (typeof chunk.toolCallId !== 'string') return null
      // The wire emits `output: part.output` directly (no `toJSONValue`
      // wrapping at this layer). When `part.output` is `undefined`,
      // `JSON.stringify` drops the key entirely, so `'output' in chunk`
      // reads false on the receiving side. Treat absence as an explicit
      // `null` result — finalizing the invocation is what stops the
      // spinner; ignoring the chunk would hang the UI forever for any
      // tool whose `execute` returns undefined.
      const result = 'output' in chunk ? chunk.output : null
      return { type: 'finalize-tool-call', toolCallId: chunk.toolCallId, result }
    }

    case 'tool-input-error': {
      if (typeof chunk.toolCallId !== 'string' || typeof chunk.toolName !== 'string') return null
      const errorText = typeof chunk.errorText === 'string' ? chunk.errorText : 'Tool input rejected'
      return {
        type: 'fail-tool-input',
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
        errorText,
      }
    }

    case 'tool-output-error': {
      if (typeof chunk.toolCallId !== 'string') return null
      const errorText = typeof chunk.errorText === 'string' ? chunk.errorText : 'Tool execution failed'
      return { type: 'fail-tool-output', toolCallId: chunk.toolCallId, errorText }
    }

    case 'error': {
      const errorText = typeof chunk.errorText === 'string' ? chunk.errorText : 'Stream error'
      return { type: 'stream-error', errorText }
    }

    case 'abort':
      return { type: 'abort' }

    // Forward-compat: silently ignore lifecycle markers (start/finish,
    // start-step/finish-step), text-start/-end, tool-input-start/-delta,
    // reasoning-*, source-*, message-metadata.
    default:
      return null
  }
}
