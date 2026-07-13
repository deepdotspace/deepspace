/**
 * Tests for the v5 UIMessage stream decoder.
 *
 * The fixtures below mirror what `toUIMessageStreamResponse` actually emits
 * (verified against the installed `ai/dist/index.js` — `JsonToSseTransformStream`
 * at line 2918, the chunk types in `ai/dist/index.d.ts:UIMessageChunk`). Both
 * shapes are easy to drift on; we assert directly so a future SDK rename or
 * framing change surfaces here, not in production.
 */

import { describe, it, expect } from 'vitest'
import { parseSseLine, decodeAiStreamChunk, type AiStreamAction } from '../ai-stream'

describe('parseSseLine', () => {
  it('strips the `data: ` prefix and JSON-parses the payload', () => {
    const out = parseSseLine('data: {"type":"text-delta","delta":"hi"}')
    expect(out).toEqual({ type: 'text-delta', delta: 'hi' })
  })

  it('handles `data:` without the optional space after the colon', () => {
    // The SSE spec lets the single space after the colon be elided.
    const out = parseSseLine('data:{"type":"abort"}')
    expect(out).toEqual({ type: 'abort' })
  })

  it('returns null for the [DONE] sentinel', () => {
    expect(parseSseLine('data: [DONE]')).toBeNull()
  })

  it('returns null for blank lines (the second `\\n` of each event)', () => {
    expect(parseSseLine('')).toBeNull()
  })

  it('returns null for SSE comment lines', () => {
    expect(parseSseLine(': this is a heartbeat')).toBeNull()
  })

  it('returns null for non-`data:` SSE fields', () => {
    // v5 doesn't emit these but the parser must not blow up if a proxy adds them.
    expect(parseSseLine('event: ping')).toBeNull()
    expect(parseSseLine('id: 42')).toBeNull()
    expect(parseSseLine('retry: 1000')).toBeNull()
  })

  it('returns null when the payload is malformed JSON', () => {
    expect(parseSseLine('data: not json')).toBeNull()
  })

  it('returns null when the payload is a JSON primitive (not an object)', () => {
    // We only accept event objects; primitives carry no `type` and would
    // confuse the downstream decoder.
    expect(parseSseLine('data: 42')).toBeNull()
    expect(parseSseLine('data: "hello"')).toBeNull()
    expect(parseSseLine('data: null')).toBeNull()
  })
})

describe('decodeAiStreamChunk', () => {
  function decode(chunk: Record<string, unknown>): AiStreamAction | null {
    return decodeAiStreamChunk(chunk)
  }

  describe('text-delta', () => {
    it('emits append-text with the delta string', () => {
      expect(decode({ type: 'text-delta', delta: 'Hello', id: 't1' })).toEqual({
        type: 'append-text',
        delta: 'Hello',
      })
    })

    it('ignores empty deltas (no UI side effect)', () => {
      expect(decode({ type: 'text-delta', delta: '', id: 't1' })).toBeNull()
    })

    it('ignores deltas with non-string `delta` field', () => {
      expect(decode({ type: 'text-delta', delta: 42, id: 't1' })).toBeNull()
    })
  })

  describe('tool-input-available (finalized tool call)', () => {
    it('emits upsert-tool-call mapping wire `input` → action `input`', () => {
      // Wire shape verified at `provider-utils/dist/index.d.ts:ToolCallPart`
      // and `ai/dist/index.d.ts:UIMessageChunk` (the chunk variant).
      const chunk = {
        type: 'tool-input-available',
        toolCallId: 'call_1',
        toolName: 'records.query',
        input: { collection: 'users' },
      }
      expect(decode(chunk)).toEqual({
        type: 'upsert-tool-call',
        toolCallId: 'call_1',
        toolName: 'records.query',
        input: { collection: 'users' },
      })
    })

    it('rejects chunks missing toolCallId or toolName', () => {
      expect(decode({ type: 'tool-input-available', toolName: 'x', input: {} })).toBeNull()
      expect(decode({ type: 'tool-input-available', toolCallId: 'c', input: {} })).toBeNull()
    })
  })

  describe('tool-output-available (tool result)', () => {
    it('emits finalize-tool-call with the raw `output` value as `result`', () => {
      // The UI-stream `output` is the RAW tool return value, not the
      // `{ type: 'json', value }` wrapper that appears in
      // `response.messages` content blocks server-side.
      const chunk = {
        type: 'tool-output-available',
        toolCallId: 'call_1',
        output: { items: [{ id: 'a' }, { id: 'b' }] },
      }
      expect(decode(chunk)).toEqual({
        type: 'finalize-tool-call',
        toolCallId: 'call_1',
        result: { items: [{ id: 'a' }, { id: 'b' }] },
      })
    })

    it('preserves a falsy result (e.g. null) — distinguishes "ran with null" from "missing"', () => {
      const chunk = { type: 'tool-output-available', toolCallId: 'call_1', output: null }
      expect(decode(chunk)).toEqual({ type: 'finalize-tool-call', toolCallId: 'call_1', result: null })
    })

    it('rejects chunks missing toolCallId entirely', () => {
      expect(decode({ type: 'tool-output-available', output: {} })).toBeNull()
    })

    it('treats a missing `output` key as an explicit null result', () => {
      // The wire serializes `output: undefined` as a missing key
      // (`JSON.stringify` drops undefined values), so a tool whose
      // `execute` returns undefined would otherwise hang the UI's
      // spinner forever. Finalize with null instead.
      expect(decode({ type: 'tool-output-available', toolCallId: 'c' })).toEqual({
        type: 'finalize-tool-call',
        toolCallId: 'c',
        result: null,
      })
    })
  })

  describe('tool-input-error (validation failed before tool ran)', () => {
    it('emits fail-tool-input so the UI creates AND finalizes the invocation in one step', () => {
      // No `tool-input-available` precedes this chunk, so a finalize-only
      // path would silently do nothing and leave the spinner stuck.
      const chunk = {
        type: 'tool-input-error',
        toolCallId: 'call_2',
        toolName: 'records.query',
        input: { collection: 42 }, // wrong type — schema rejected
        errorText: 'collection: Expected string, received number',
      }
      expect(decode(chunk)).toEqual({
        type: 'fail-tool-input',
        toolCallId: 'call_2',
        toolName: 'records.query',
        input: { collection: 42 },
        errorText: 'collection: Expected string, received number',
      })
    })

    it('falls back to a generic errorText if the chunk omits one', () => {
      const out = decode({
        type: 'tool-input-error',
        toolCallId: 'call_2',
        toolName: 'records.query',
        input: {},
      })
      expect(out).toEqual({
        type: 'fail-tool-input',
        toolCallId: 'call_2',
        toolName: 'records.query',
        input: {},
        errorText: 'Tool input rejected',
      })
    })
  })

  describe('tool-output-error (tool execute threw or returned an error)', () => {
    it('emits fail-tool-output so the React layer finalizes the existing invocation', () => {
      const chunk = {
        type: 'tool-output-error',
        toolCallId: 'call_3',
        errorText: 'records.query: collection not found',
      }
      expect(decode(chunk)).toEqual({
        type: 'fail-tool-output',
        toolCallId: 'call_3',
        errorText: 'records.query: collection not found',
      })
    })

    it('falls back to a generic errorText if the chunk omits one', () => {
      expect(decode({ type: 'tool-output-error', toolCallId: 'call_3' })).toEqual({
        type: 'fail-tool-output',
        toolCallId: 'call_3',
        errorText: 'Tool execution failed',
      })
    })
  })

  describe('error (top-level stream error)', () => {
    it('emits stream-error carrying the errorText', () => {
      expect(decode({ type: 'error', errorText: 'rate limit exceeded' })).toEqual({
        type: 'stream-error',
        errorText: 'rate limit exceeded',
      })
    })

    it('falls back to a generic errorText if the chunk omits one', () => {
      expect(decode({ type: 'error' })).toEqual({ type: 'stream-error', errorText: 'Stream error' })
    })
  })

  describe('abort', () => {
    it('emits abort with no other state', () => {
      expect(decode({ type: 'abort' })).toEqual({ type: 'abort' })
    })
  })

  describe('forward-compat: ignored chunks', () => {
    // The default branch silently ignores chunk types we don't render today.
    // Listed verbatim from `ai/dist/index.d.ts:UIMessageChunk` so a v5 minor
    // bump that adds new chunks lights up this list as needing review.
    const ignored = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'finish' },
      { type: 'finish-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-end', id: 't1' },
      { type: 'tool-input-start', toolCallId: 'c', toolName: 'x' },
      { type: 'tool-input-delta', toolCallId: 'c', inputTextDelta: '{' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'thinking...' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
      { type: 'source-document', sourceId: 's1', mediaType: 'text/plain' },
      { type: 'message-metadata', messageMetadata: { foo: 1 } },
    ]
    it.each(ignored)('ignores $type', (chunk) => {
      expect(decode(chunk as Record<string, unknown>)).toBeNull()
    })
  })

  describe('malformed input', () => {
    it('returns null when chunk has no `type` field', () => {
      expect(decode({ delta: 'orphan' })).toBeNull()
    })

    it('returns null when chunk.type is non-string', () => {
      expect(decode({ type: 42 })).toBeNull()
    })

    it('returns null for unknown chunk types', () => {
      expect(decode({ type: 'something-from-the-future', payload: {} })).toBeNull()
    })
  })
})

describe('end-to-end: parseSseLine ∘ decodeAiStreamChunk', () => {
  // Captured live from a v5 streamText response in dev. If the wire format
  // ever changes (SSE → NDJSON, or chunk renames), these break first.
  const sseFixture: ReadonlyArray<{ line: string; expected: AiStreamAction | null }> = [
    { line: 'data: {"type":"start"}', expected: null },
    { line: 'data: {"type":"start-step"}', expected: null },
    { line: 'data: {"type":"text-start","id":"t1"}', expected: null },
    {
      line: 'data: {"type":"text-delta","delta":"Hello, ","id":"t1"}',
      expected: { type: 'append-text', delta: 'Hello, ' },
    },
    {
      line: 'data: {"type":"text-delta","delta":"world.","id":"t1"}',
      expected: { type: 'append-text', delta: 'world.' },
    },
    { line: 'data: {"type":"text-end","id":"t1"}', expected: null },
    {
      line: 'data: {"type":"tool-input-available","toolCallId":"call_1","toolName":"records.query","input":{"collection":"users"}}',
      expected: {
        type: 'upsert-tool-call',
        toolCallId: 'call_1',
        toolName: 'records.query',
        input: { collection: 'users' },
      },
    },
    {
      line: 'data: {"type":"tool-output-available","toolCallId":"call_1","output":{"items":[]}}',
      expected: {
        type: 'finalize-tool-call',
        toolCallId: 'call_1',
        result: { items: [] },
      },
    },
    { line: 'data: {"type":"finish-step"}', expected: null },
    { line: 'data: {"type":"finish"}', expected: null },
    { line: 'data: [DONE]', expected: null },
    { line: '', expected: null }, // event terminator newline
  ]

  it('decodes a representative streamed turn end-to-end', () => {
    const actions: AiStreamAction[] = []
    for (const { line, expected } of sseFixture) {
      const chunk = parseSseLine(line)
      const action = chunk ? decodeAiStreamChunk(chunk) : null
      expect(action).toEqual(expected)
      if (action) actions.push(action)
    }
    // Sanity: the only events that produced actions were the two text deltas
    // and the tool-input-available + tool-output-available pair.
    expect(actions.map((a) => a.type)).toEqual([
      'append-text',
      'append-text',
      'upsert-tool-call',
      'finalize-tool-call',
    ])
  })
})
