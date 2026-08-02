import { describe, expect, it } from 'vitest'
import { buildUiParts, turnsToCoreMessages, unwrapToolOutput } from '../chat-context'

function asResponseMessages(messages: unknown[]): Parameters<typeof buildUiParts>[0] {
  return messages as Parameters<typeof buildUiParts>[0]
}

describe('turnsToCoreMessages', () => {
  it('passes through user/system/assistant text turns', () => {
    const out = turnsToCoreMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('splits assistant turn at tool-invocation boundaries (text-after-tool becomes its own assistant message)', () => {
    // Anthropic rejects [text, tool_use, text] in a single assistant message —
    // the trailing text breaks tool_use → tool_result pairing. The split must
    // mirror the original multi-step flow: text-before + tool_use, then tool,
    // then text-after as a fresh assistant message.
    const parts = [
      { type: 'text', text: 'querying...' },
      {
        type: 'tool-invocation',
        toolCallId: 'call_1',
        toolInvocation: {
          toolName: 'records.query',
          state: 'result',
          args: { collection: 'x' },
          result: { rows: 3 },
        },
      },
      { type: 'text', text: 'found 3 rows' },
    ]
    const out = turnsToCoreMessages([
      { role: 'assistant', content: 'querying...found 3 rows', parts },
    ])
    expect(out).toHaveLength(3)
    // v5 SDK boundary shape: tool-call uses `input`, tool-result uses
    // `output` wrapped as `{ type: 'json', value }`. Persisted ChatTurn
    // shape (the input to turnsToCoreMessages) still uses `args`/`result`.
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'querying...' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'records.query',
          input: { collection: 'x' },
        },
      ],
    })
    expect(out[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'records.query',
          output: { type: 'json', value: { rows: 3 } },
        },
      ],
    })
    expect(out[2]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'found 3 rows' }],
    })
  })

  it('handles multiple tool calls interleaved with text', () => {
    const parts = [
      { type: 'text', text: 'first' },
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolInvocation: { toolName: 't1', state: 'result', args: {}, result: { v: 1 } },
      },
      { type: 'text', text: 'middle' },
      {
        type: 'tool-invocation',
        toolCallId: 'b',
        toolInvocation: { toolName: 't2', state: 'result', args: {}, result: { v: 2 } },
      },
      { type: 'text', text: 'last' },
    ]
    const out = turnsToCoreMessages([{ role: 'assistant', content: '', parts }])
    expect(out.map((m: { role: string }) => m.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
  })

  it('drops tool-invocation entries without a paired result', () => {
    const parts = [
      { type: 'text', text: 'before' },
      {
        type: 'tool-invocation',
        toolCallId: 'call_orphan',
        toolInvocation: { toolName: 'records.query', state: 'call', args: {} },
      },
    ]
    const out = turnsToCoreMessages([{ role: 'assistant', content: 'before', parts }])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'before' }] })
  })

  it('falls back to plain content when assistant has no parts', () => {
    const out = turnsToCoreMessages([{ role: 'assistant', content: 'just text', parts: [] }])
    expect(out).toEqual([{ role: 'assistant', content: 'just text' }])
  })

  it('skips an assistant turn that has neither parts nor content', () => {
    const out = turnsToCoreMessages([{ role: 'assistant', content: '' }])
    expect(out).toEqual([])
  })

  // The persisted assistant row carries `content` as a flattened concat of its
  // text parts (built in `buildUiParts`); the AI SDK ModelMessage round-trip
  // expects parts only — so we should NOT also emit content as a duplicate text
  // part when parts already cover it.
  it('does not duplicate content text when assistant parts already include text', () => {
    const parts = [
      { type: 'text', text: 'querying...' },
      { type: 'text', text: 'found 3 rows' },
    ]
    const out = turnsToCoreMessages([
      { role: 'assistant', content: 'querying...found 3 rows', parts },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'querying...' },
        { type: 'text', text: 'found 3 rows' },
      ],
    })
  })

  it('emits matching tool-call and tool-result counts (paired by construction)', () => {
    const out = turnsToCoreMessages([
      {
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool-invocation',
            toolCallId: 'a',
            toolInvocation: { toolName: 't1', state: 'result', args: {}, result: 1 },
          },
          { type: 'text', text: 'between' },
          {
            type: 'tool-invocation',
            toolCallId: 'b',
            toolInvocation: { toolName: 't2', state: 'result', args: {}, result: 2 },
          },
        ],
      },
    ])
    let calls = 0
    let results = 0
    for (const m of out) {
      if (!Array.isArray(m.content)) continue
      for (const c of m.content as Array<{ type: string }>) {
        if (c.type === 'tool-call') calls++
        else if (c.type === 'tool-result') results++
      }
    }
    expect(calls).toBe(2)
    expect(results).toBe(2)
  })

  it('skips tool-invocation parts missing toolCallId or toolName', () => {
    const parts = [
      { type: 'text', text: 'before' },
      // missing toolCallId
      {
        type: 'tool-invocation',
        toolInvocation: { toolName: 't1', state: 'result', result: { v: 1 } },
      },
      // missing toolName
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolInvocation: { state: 'result', result: { v: 1 } },
      },
      { type: 'text', text: 'after' },
    ]
    const out = turnsToCoreMessages([{ role: 'assistant', content: '', parts }])
    // No tool boundaries → single assistant message with both texts.
    expect(out).toHaveLength(1)
    expect((out[0].content as Array<{ type: string }>).map((c) => c.type)).toEqual(['text', 'text'])
  })

  it('emits nothing for an assistant turn whose only parts are state:call (orphan tool calls) and content is empty', () => {
    const out = turnsToCoreMessages([
      {
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool-invocation',
            toolCallId: 'a',
            toolInvocation: { toolName: 't1', state: 'call' },
          },
        ],
      },
    ])
    expect(out).toEqual([])
  })

  it('skips empty-text parts to avoid emitting empty content arrays', () => {
    const out = turnsToCoreMessages([
      { role: 'assistant', content: '', parts: [{ type: 'text', text: '' }] },
    ])
    // No real text and no tools → nothing to emit.
    expect(out).toEqual([])
  })

  it('handles malformed parts entries (null, primitive, missing type) without throwing', () => {
    const out = turnsToCoreMessages([
      {
        role: 'assistant',
        content: 'fallback',
        parts: [null, 'string', 42, { foo: 'bar' }, { type: 'unknown' }] as unknown[],
      },
    ])
    // No emittable parts → falls back to plain content.
    expect(out).toEqual([{ role: 'assistant', content: 'fallback' }])
  })
})

describe('unwrapToolOutput', () => {
  it('unwraps `{type:"json", value}` to the raw value', () => {
    expect(unwrapToolOutput({ type: 'json', value: { items: [1, 2] } })).toEqual({ items: [1, 2] })
  })

  it('unwraps `{type:"text", value}` to the raw string', () => {
    expect(unwrapToolOutput({ type: 'text', value: 'hello' })).toBe('hello')
  })

  it('remaps `{type:"error-text", value}` to {success:false, error}', () => {
    expect(unwrapToolOutput({ type: 'error-text', value: 'boom' })).toEqual({
      success: false,
      error: 'boom',
    })
  })

  it('remaps `{type:"error-json", value}` to {success:false, error}', () => {
    expect(unwrapToolOutput({ type: 'error-json', value: { code: 'E_RBAC' } })).toEqual({
      success: false,
      error: { code: 'E_RBAC' },
    })
  })

  it('passes through `{type:"content", value}` unmodified (no in-tree tool emits it)', () => {
    const content = { type: 'content', value: [{ type: 'text', text: 'x' }] }
    expect(unwrapToolOutput(content)).toBe(content)
  })

  it('passes through unknown tags unchanged', () => {
    const weird = { type: 'something-new', value: 42 }
    expect(unwrapToolOutput(weird)).toBe(weird)
  })

  it('passes through primitives and non-objects', () => {
    expect(unwrapToolOutput('plain')).toBe('plain')
    expect(unwrapToolOutput(42)).toBe(42)
    expect(unwrapToolOutput(null)).toBe(null)
  })

  it('falls back to a generic error message when value is missing on an error tag', () => {
    expect(unwrapToolOutput({ type: 'error-text' })).toEqual({
      success: false,
      error: 'Tool execution failed',
    })
  })
})

describe('buildUiParts', () => {
  it('handles a plain text-only response', () => {
    const out = buildUiParts(
      asResponseMessages([{ role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }]),
    )
    expect(out).toEqual([{ type: 'text', text: 'hi there' }])
  })

  it('handles a string-content assistant message (some providers emit this)', () => {
    const out = buildUiParts(asResponseMessages([{ role: 'assistant', content: 'plain string' }]))
    expect(out).toEqual([{ type: 'text', text: 'plain string' }])
  })

  it('pairs assistant tool-call with tool-message tool-result and unwraps output', () => {
    const out = buildUiParts(
      asResponseMessages([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'querying' },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'records.query',
              input: { collection: 'x' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'records.query',
              output: { type: 'json', value: { rows: 3 } },
            },
          ],
        },
      ]),
    )
    expect(out).toEqual([
      { type: 'text', text: 'querying' },
      {
        type: 'tool-invocation',
        toolCallId: 'c1',
        toolInvocation: {
          toolName: 'records.query',
          state: 'result',
          args: { collection: 'x' },
          result: { rows: 3 },
        },
      },
    ])
  })

  it('emits text-then-invocation-then-text for a multi-step turn', () => {
    const out = buildUiParts(
      asResponseMessages([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 't',
              output: { type: 'json', value: 'ok' },
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'after' }] },
      ]),
    )
    expect(out.map((p) => (p as { type: string }).type)).toEqual([
      'text',
      'tool-invocation',
      'text',
    ])
  })

  it('drops orphan tool-calls that have no matching tool-result', () => {
    // Provider quirk / mid-step failure scenarios.
    const out = buildUiParts(
      asResponseMessages([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'starting' },
            { type: 'tool-call', toolCallId: 'orphan', toolName: 't', input: {} },
          ],
        },
      ]),
    )
    expect(out).toEqual([{ type: 'text', text: 'starting' }])
  })

  it('maps an error-tagged tool result to {success:false, error}', () => {
    const out = buildUiParts(
      asResponseMessages([
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 't', input: {} }],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 't',
              output: { type: 'error-text', value: 'denied' },
            },
          ],
        },
      ]),
    )
    expect(out).toEqual([
      {
        type: 'tool-invocation',
        toolCallId: 'c1',
        toolInvocation: {
          toolName: 't',
          state: 'result',
          args: {},
          result: { success: false, error: 'denied' },
        },
      },
    ])
  })

  it('skips empty text content blocks', () => {
    const out = buildUiParts(
      asResponseMessages([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'kept' },
          ],
        },
      ]),
    )
    expect(out).toEqual([{ type: 'text', text: 'kept' }])
  })
})
