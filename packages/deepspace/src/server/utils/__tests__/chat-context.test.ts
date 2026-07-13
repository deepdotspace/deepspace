import { describe, it, expect, vi } from 'vitest'
import {
  applySlidingWindow,
  capToolResultSize,
  truncateOldToolResults,
  prepareMessagesWithCompaction,
  turnsToCoreMessages,
  buildUiParts,
  unwrapToolOutput,
  type ChatTurn,
  type ChatContextConfig,
  DEFAULT_CONTEXT_CONFIG,
} from '../chat-context'

// Cast helper — `buildUiParts` takes a real `ModelMessage[]`, but tests
// build inline literals; the runtime cares only about the duck-typed
// `role` / `content` fields we read.
function asResponseMessages(msgs: unknown[]): Parameters<typeof buildUiParts>[0] {
  return msgs as Parameters<typeof buildUiParts>[0]
}

/** Shape of a tool-invocation UI part the tests read (not on the public part type). */
interface ToolInvocationPart {
  toolInvocation: { state?: string; result: Record<string, unknown> & { _truncated?: boolean } }
}

/** Read the `.toolInvocation` off a UI message part (runtime-present, off-type). */
function readToolInvocation(part: unknown): ToolInvocationPart['toolInvocation'] {
  return (part as ToolInvocationPart).toolInvocation
}

function u(content: string): ChatTurn {
  return { role: 'user', content }
}
function a(content: string, parts?: unknown[]): ChatTurn {
  return { role: 'assistant', content, parts }
}
function s(content: string, id?: string): ChatTurn {
  return { role: 'system', content, id }
}
function toolPart(toolName: string, result: unknown, state: 'call' | 'result' = 'result') {
  return { type: 'tool-invocation', toolInvocation: { toolName, state, result } }
}

describe('applySlidingWindow', () => {
  it('returns unchanged when under cap', () => {
    const msgs = [u('hi'), a('there')]
    expect(applySlidingWindow(msgs, 10_000, 2)).toBe(msgs)
  })

  it('drops oldest first until under cap', () => {
    const msgs = [u('A'.repeat(100)), u('B'.repeat(100)), u('C'.repeat(100)), u('D'.repeat(50))]
    const out = applySlidingWindow(msgs, 200, 1)
    expect(out.map((m) => m.content[0])).toEqual(['C', 'D'])
  })

  it('respects minKept even when still over cap', () => {
    const msgs = [u('A'.repeat(500)), u('B'.repeat(500)), u('C'.repeat(500))]
    const out = applySlidingWindow(msgs, 100, 2)
    expect(out).toHaveLength(2)
  })

  it('preserves system messages and drops user/assistant first', () => {
    const msgs = [
      s('summary pinned', 'summary-m1'),
      u('A'.repeat(500)),
      u('B'.repeat(500)),
      u('C'.repeat(100)),
    ]
    const out = applySlidingWindow(msgs, 300, 1)
    // Summary still present; oldest non-system was dropped first.
    expect(out.find((m) => m.role === 'system')).toBeDefined()
    expect(out[0].role).toBe('system')
    expect(out.map((m) => m.content[0])).not.toContain('A')
  })
})

describe('capToolResultSize', () => {
  it('returns input unchanged under cap', () => {
    const payload = { data: [1, 2, 3] }
    expect(capToolResultSize(payload, 1000)).toBe(payload)
  })

  it('replaces with error + preview only for a non-array payload over cap', () => {
    // No trimmable array here (the bloat is a string), so there is nothing to
    // degrade — falls back to the informative error.
    const big = { data: 'x'.repeat(5000) }
    const out = capToolResultSize(big, 1000) as Record<string, unknown>
    expect(out.success).toBe(false)
    expect(out.truncated).toBe(true)
    expect(typeof out.preview).toBe('string')
    expect((out.preview as string).length).toBeLessThanOrEqual(2000)
  })

  it('degrades an array-bearing result to a usable prefix instead of nuking it', () => {
    const records = Array.from({ length: 200 }, (_, i) => ({ id: i, blob: 'y'.repeat(200) }))
    const out = capToolResultSize({ records }, 3000) as Record<string, unknown>
    // Success shape preserved — caller can still read the partial data.
    expect(out.success).toBeUndefined() // top-level success untouched (none was set)
    expect(out.truncated).toBe(true)
    expect(out.total).toBe(200)
    expect(Array.isArray(out.records)).toBe(true)
    expect((out.records as unknown[]).length).toBe(out.returned)
    expect((out.returned as number)).toBeGreaterThan(0)
    expect((out.returned as number)).toBeLessThan(200)
    // The returned page actually fits under the cap.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3000)
    // Leading items, in order, are preserved.
    expect((out.records as { id: number }[])[0].id).toBe(0)
  })

  it('degrades the records.query tool-result shape, preserving success:true', () => {
    const records = Array.from({ length: 300 }, (_, i) => ({ id: i, blob: 'z'.repeat(150) }))
    const result = { success: true, data: { records, count: records.length } }
    const out = capToolResultSize(result, 4000) as { success: boolean; data: Record<string, unknown> }
    // success stays true at the top level — app code reading result.data.records
    // gets a real (partial) page, not a failed result.
    expect(out.success).toBe(true)
    expect(out.data.truncated).toBe(true)
    expect(out.data.total).toBe(300)
    expect((out.data.records as unknown[]).length).toBe(out.data.returned)
    expect((out.data.returned as number)).toBeGreaterThan(0)
    expect((out.data.returned as number)).toBeLessThan(300)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4000)
  })

  it('falls back to the error when even an empty list cannot fit (bloat in siblings)', () => {
    // Tiny array, but a huge sibling field — trimming the array can't help, so
    // we still get the informative error rather than a bogus "empty page".
    const out = capToolResultSize(
      { records: [{ id: 1 }], note: 'q'.repeat(5000) },
      1000,
    ) as Record<string, unknown>
    expect(out.success).toBe(false)
    expect(out.truncated).toBe(true)
    expect(typeof out.preview).toBe('string')
  })

  it('falls back to the error when a single record alone exceeds the cap (no empty "no results" page)', () => {
    // One oversized record: an empty list fits but not even one record does, so
    // the prefix search lands on 0. Returning that empty page would read like a
    // genuine "no results"; instead we surface the actionable error.
    const out = capToolResultSize(
      { success: true, data: { records: [{ id: 1, blob: 'q'.repeat(5000) }], count: 1 } },
      1000,
    ) as Record<string, unknown>
    expect(out.success).toBe(false)
    expect(out.truncated).toBe(true)
    expect(typeof out.preview).toBe('string')
  })

  it('handles unserializable input', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const out = capToolResultSize(cyclic, 100) as Record<string, unknown>
    expect(out.success).toBe(false)
  })
})

describe('truncateOldToolResults', () => {
  it('keeps the last N tool results intact', () => {
    const msgs: ChatTurn[] = [
      a('one', [toolPart('search', { hits: 1 })]),
      a('two', [toolPart('search', { hits: 2 })]),
      a('three', [toolPart('search', { hits: 3 })]),
    ]
    const out = truncateOldToolResults(msgs, 2)
    const r0 = readToolInvocation(out[0].parts![0]).result
    const r1 = readToolInvocation(out[1].parts![0]).result
    const r2 = readToolInvocation(out[2].parts![0]).result
    expect(r0._truncated).toBe(true)
    expect(r1.hits).toBe(2)
    expect(r2.hits).toBe(3)
  })

  it('preserves success:false results untouched', () => {
    const msgs: ChatTurn[] = [
      a('first', [toolPart('search', { success: false, error: 'boom' })]),
      a('next', []),
      a('next', []),
      a('next', []),
    ]
    const out = truncateOldToolResults(msgs, 1)
    const result = readToolInvocation(out[0].parts![0]).result
    expect(result.success).toBe(false)
    expect(result.error).toBe('boom')
  })

  it('preserves assistant text around truncated results', () => {
    const msgs: ChatTurn[] = [
      a('reasoning text', [toolPart('search', { hits: 1 })]),
      a('newer', [toolPart('search', { hits: 2 })]),
    ]
    const out = truncateOldToolResults(msgs, 1)
    expect(out[0].content).toBe('reasoning text')
  })
})

describe('prepareMessagesWithCompaction', () => {
  const smallConfig: ChatContextConfig = {
    ...DEFAULT_CONTEXT_CONFIG,
    contextBudget: 2000,
    keepRecentToolResults: 2,
    minKept: 2,
  }

  function withId(turn: ChatTurn, id: string): ChatTurn {
    return { ...turn, id }
  }

  it('returns input unchanged when under budget; summarizer not called', async () => {
    const summarizer = vi.fn(async () => 'mock summary text')
    const msgs = [u('hi'), a('hello')]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, { summarizer })
    expect(out.messages).toEqual(msgs)
    expect(out.newSummary).toBeUndefined()
    expect(summarizer).not.toHaveBeenCalled()
  })

  it('summarizes older half when over budget with no cached summary', async () => {
    const summarizer = vi.fn(async () => 'mock summary text')
    const big = 'x'.repeat(800)
    const msgs: ChatTurn[] = [
      withId(u(big), 'm1'),
      withId(a(big), 'm2'),
      withId(u(big), 'm3'),
      withId(a(big), 'm4'),
    ]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, { summarizer })
    expect(summarizer).toHaveBeenCalledTimes(1)
    expect(out.newSummary).toEqual({ text: 'mock summary text', throughId: 'm2' })
    expect(out.messages[0].role).toBe('system')
    expect(out.messages[0].content).toContain('mock summary text')
  })

  it('reuses cached summary when its throughId matches a message', async () => {
    const summarizer = vi.fn(async () => 'fresh summary')
    const big = 'x'.repeat(800)
    const msgs: ChatTurn[] = [
      withId(u(big), 'm1'),
      withId(a(big), 'm2'),
      withId(u(big), 'm3'),
      withId(a(big), 'm4'),
    ]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, {
      summarizer,
      cachedSummary: { text: 'cached summary', throughId: 'm2' },
    })
    expect(summarizer).not.toHaveBeenCalled()
    expect(out.newSummary).toBeUndefined()
    expect(out.messages[0].role).toBe('system')
    expect(out.messages[0].content).toContain('cached summary')
  })

  it('re-summarizes when cached summary is applied and still over budget', async () => {
    const summarizer = vi.fn(async () => 'fresh rolled-up summary')
    const big = 'x'.repeat(800)
    // Cached summary covers through m2; subsequent turns m3..m6 push us over
    // the budget again. After applying the cached summary, working becomes
    // [systemSummary, m3, m4, m5, m6] which is still over 2000 chars.
    const msgs: ChatTurn[] = [
      withId(u(big), 'm1'),
      withId(a(big), 'm2'),
      withId(u(big), 'm3'),
      withId(a(big), 'm4'),
      withId(u(big), 'm5'),
      withId(a(big), 'm6'),
    ]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, {
      summarizer,
      cachedSummary: { text: 'old cached summary', throughId: 'm2' },
    })
    expect(summarizer).toHaveBeenCalledTimes(1)
    expect(out.newSummary).toBeDefined()
    expect(out.newSummary!.text).toBe('fresh rolled-up summary')
    expect(out.messages[0].role).toBe('system')
    expect(out.messages[0].content).toContain('fresh rolled-up summary')
  })

  it('skips synthetic summary-* ids when picking throughId for re-summarization', async () => {
    // After a cached summary is applied, working[0] is a synthetic system
    // message with id `summary-...`. If working is short enough that older
    // contains only that synthetic message, we must NOT persist its id as
    // the next throughId — it doesn't exist in real history, so the next
    // turn would fail to find it and re-summarize from scratch (billing leak).
    const summarizer = vi.fn(async () => 'rolled-up')
    const big = 'x'.repeat(900)
    const out = await prepareMessagesWithCompaction(
      [withId(u(big), 'm5'), withId(a(big), 'm6')],
      smallConfig,
      { summarizer, cachedSummary: { text: 'old', throughId: 'm5' } },
    )
    // After applying cached summary: [synthetic-summary, m6]. Over budget.
    // half=1 → older=[synthetic]. The fix walks backwards past it; no real
    // id is available, so summarization is skipped and we fall through to
    // the sliding window. newSummary stays undefined.
    expect(out.newSummary).toBeUndefined()
  })

  it('falls back to sliding window when summarizer throws', async () => {
    // The fallback logs the failure via console.error by design — silence it
    // here (and assert it fired) so the intentional error doesn't look like a
    // real test failure in the output.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const summarizer = vi.fn(async () => {
      throw new Error('summarizer down')
    })
    const big = 'x'.repeat(800)
    const msgs: ChatTurn[] = [
      withId(u(big), 'm1'),
      withId(a(big), 'm2'),
      withId(u(big), 'm3'),
      withId(a(big), 'm4'),
    ]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, { summarizer })
    expect(summarizer).toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    expect(out.newSummary).toBeUndefined()
    expect(out.messages.length).toBeGreaterThanOrEqual(smallConfig.minKept)
    errSpy.mockRestore()
  })
})

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
        toolInvocation: { toolName: 'records.query', state: 'result', args: { collection: 'x' }, result: { rows: 3 } },
      },
      { type: 'text', text: 'found 3 rows' },
    ]
    const out = turnsToCoreMessages([{ role: 'assistant', content: 'querying...found 3 rows', parts }])
    expect(out).toHaveLength(3)
    // v5 SDK boundary shape: tool-call uses `input`, tool-result uses
    // `output` wrapped as `{ type: 'json', value }`. Persisted ChatTurn
    // shape (the input to turnsToCoreMessages) still uses `args`/`result`.
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'querying...' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'records.query', input: { collection: 'x' } },
      ],
    })
    expect(out[1]).toEqual({
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call_1', toolName: 'records.query', output: { type: 'json', value: { rows: 3 } } },
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
    expect(out.map((m: { role: string }) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant'])
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
})

describe('truncateOldToolResults — edge cases', () => {
  it('passes through assistant rows with non-array parts', () => {
    const msgs: ChatTurn[] = [
      // parts is undefined — common for plain-text assistant rows.
      { role: 'assistant', content: 'plain text 1' },
      // parts intentionally non-array — defensive against bad rows.
      { role: 'assistant', content: 'plain text 2', parts: 'not-an-array' as unknown as unknown[] },
      a('newer', [toolPart('search', { hits: 99 })]),
    ]
    const out = truncateOldToolResults(msgs, 1)
    expect(out[0]).toEqual(msgs[0])
    expect(out[1]).toEqual(msgs[1])
    expect(readToolInvocation(out[2].parts![0]).result.hits).toBe(99)
  })

  it('leaves tool-invocation in state:call alone (not yet a result)', () => {
    const msgs: ChatTurn[] = [
      a('mid-stream', [toolPart('search', undefined, 'call')]),
      a('newer', [toolPart('search', { hits: 1 })]),
      a('newer', [toolPart('search', { hits: 2 })]),
    ]
    const out = truncateOldToolResults(msgs, 1)
    // call-state survives untouched (no result to redact).
    const inv = readToolInvocation(out[0].parts![0])
    expect(inv.state).toBe('call')
    expect(inv.result).toBeUndefined()
  })
})

describe('turnsToCoreMessages — invariant', () => {
  it('emits matching tool-call and tool-result counts (paired by construction)', () => {
    const out = turnsToCoreMessages([
      {
        role: 'assistant',
        content: '',
        parts: [
          { type: 'tool-invocation', toolCallId: 'a', toolInvocation: { toolName: 't1', state: 'result', args: {}, result: 1 } },
          { type: 'text', text: 'between' },
          { type: 'tool-invocation', toolCallId: 'b', toolInvocation: { toolName: 't2', state: 'result', args: {}, result: 2 } },
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
})

describe('applySlidingWindow — edge cases', () => {
  it('exits cleanly when only system messages remain (cannot drop below pin)', () => {
    // Two system messages, both large. Cap forces eviction but every message
    // is system → findIndex returns -1 → loop must break, not infinite-loop.
    const msgs: ChatTurn[] = [
      s('A'.repeat(500), 'sys-1'),
      s('B'.repeat(500), 'sys-2'),
    ]
    const out = applySlidingWindow(msgs, 100, 0)
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('system')
    expect(out[1].role).toBe('system')
  })
})

describe('truncateOldToolResults — extra edge cases', () => {
  it('returns empty array unchanged', () => {
    expect(truncateOldToolResults([], 5)).toEqual([])
  })

  it('returns user-only history unchanged (no assistants to truncate)', () => {
    const msgs: ChatTurn[] = [u('a'), u('b'), u('c')]
    const out = truncateOldToolResults(msgs, 1)
    expect(out).toEqual(msgs)
  })

  it('keepRecent=0 truncates ALL assistant tool results', () => {
    // Edge of the protectedStart formula: when keepRecent is 0, every
    // assistant turn precedes the (nonexistent) protected window.
    const msgs: ChatTurn[] = [
      a('a', [toolPart('search', { hits: 1 })]),
      a('b', [toolPart('search', { hits: 2 })]),
    ]
    const out = truncateOldToolResults(msgs, 0)
    expect(readToolInvocation(out[0].parts![0]).result._truncated).toBe(true)
    expect(readToolInvocation(out[1].parts![0]).result._truncated).toBe(true)
  })
})

describe('capToolResultSize — extra edge cases', () => {
  it('passes null through under cap (JSON.stringify(null) === "null")', () => {
    expect(capToolResultSize(null, 1000)).toBe(null)
  })

  // JSON.stringify returns the *value* undefined for `undefined`, bare
  // functions, and symbols. The size guard now passes those through; only
  // serializable payloads are subject to capping.
  it('passes undefined through unchanged', () => {
    expect(capToolResultSize(undefined, 1000)).toBeUndefined()
  })

  it('passes a bare function through unchanged', () => {
    const fn = () => 1
    expect(capToolResultSize(fn, 1000)).toBe(fn)
  })
})

describe('prepareMessagesWithCompaction — extra edge cases', () => {
  it('returns empty input unchanged', async () => {
    const summarizer = vi.fn(async () => 'unused')
    const out = await prepareMessagesWithCompaction([], DEFAULT_CONTEXT_CONFIG, { summarizer })
    expect(out.messages).toEqual([])
    expect(out.newSummary).toBeUndefined()
    expect(summarizer).not.toHaveBeenCalled()
  })

  it('does not anchor on a synthetic id even when no real older id is present (no billing leak)', async () => {
    // Reproduces the synthetic-id-skip rationale at function level: working
    // is [synthetic-summary, m6]; older=[synthetic]; no real id → must NOT
    // persist a `summary-...` throughId (which would never re-match history
    // and force re-summarize every turn).
    const summarizer = vi.fn(async () => 'should not run')
    const big = 'x'.repeat(900)
    const out = await prepareMessagesWithCompaction(
      [{ role: 'user', content: big, id: 'm6' }],
      { ...DEFAULT_CONTEXT_CONFIG, contextBudget: 100, minKept: 1, keepRecentToolResults: 2 },
      { summarizer, cachedSummary: { text: 'cached', throughId: 'NEVER_PRESENT' } },
    )
    // cachedSummary's throughId 'NEVER_PRESENT' is not in messages, so cache
    // is NOT applied. messages collapse via sliding window only.
    expect(out.newSummary?.throughId).not.toMatch(/^summary-/)
  })
})

describe('turnsToCoreMessages — extra edge cases', () => {
  it('skips tool-invocation parts missing toolCallId or toolName', () => {
    const parts = [
      { type: 'text', text: 'before' },
      // missing toolCallId
      { type: 'tool-invocation', toolInvocation: { toolName: 't1', state: 'result', result: { v: 1 } } },
      // missing toolName
      { type: 'tool-invocation', toolCallId: 'a', toolInvocation: { state: 'result', result: { v: 1 } } },
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
          { type: 'tool-invocation', toolCallId: 'a', toolInvocation: { toolName: 't1', state: 'call' } },
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

// ============================================================================
// User-scenario tests — multi-round summarization (the "already-summarized
// once, what happens next?" path).
// ============================================================================

describe('user scenario — multi-round summarization', () => {
  const smallConfig: ChatContextConfig = {
    ...DEFAULT_CONTEXT_CONFIG,
    contextBudget: 500,
    keepRecentToolResults: 2,
    minKept: 2,
  }

  function withId(turn: ChatTurn, id: string): ChatTurn {
    return { ...turn, id }
  }

  it('feeds the prior summary into the summarizer so the new summary can roll it forward', async () => {
    let captured: ChatTurn[] | null = null
    const summarizer = vi.fn(async (m: ChatTurn[]) => {
      captured = m
      return 'fresh rolled-up summary'
    })
    const big = 'x'.repeat(150)
    const msgs: ChatTurn[] = [
      withId(u(big), 'm1'), withId(a(big), 'm2'),
      withId(u(big), 'm3'), withId(a(big), 'm4'),
      withId(u(big), 'm5'), withId(a(big), 'm6'),
    ]
    await prepareMessagesWithCompaction(msgs, smallConfig, {
      summarizer,
      cachedSummary: { text: 'PRIOR_SUMMARY_UNIQUE_TEXT', throughId: 'm2' },
    })
    expect(captured).not.toBeNull()
    // The summarizer's input must include the prior summary as a system
    // message — otherwise the new summary can't incorporate the old one and
    // information is lost across compaction rounds.
    const passed = captured!.find((m) => m.role === 'system')
    expect(passed).toBeDefined()
    expect(passed!.content).toContain('PRIOR_SUMMARY_UNIQUE_TEXT')
  })

  it('three-round chain: each round anchors on a real (non-synthetic) message id', async () => {
    const big = 'x'.repeat(150)

    // Round 1 — fresh summarize, no cached summary.
    const r1 = await prepareMessagesWithCompaction(
      [
        withId(u(big), 'm1'), withId(a(big), 'm2'),
        withId(u(big), 'm3'), withId(a(big), 'm4'),
      ],
      smallConfig,
      { summarizer: vi.fn(async () => 'r1 summary') },
    )
    expect(r1.newSummary).toBeDefined()
    expect(r1.newSummary!.throughId).not.toMatch(/^summary-/)

    // Round 2 — feed r1's summary back as cached. Add more messages.
    const r2 = await prepareMessagesWithCompaction(
      [
        withId(u(big), 'm1'), withId(a(big), 'm2'),
        withId(u(big), 'm3'), withId(a(big), 'm4'),
        withId(u(big), 'm5'), withId(a(big), 'm6'),
        withId(u(big), 'm7'), withId(a(big), 'm8'),
      ],
      smallConfig,
      {
        summarizer: vi.fn(async () => 'r2 summary'),
        cachedSummary: { text: r1.newSummary!.text, throughId: r1.newSummary!.throughId },
      },
    )
    expect(r2.newSummary).toBeDefined()
    expect(r2.newSummary!.throughId).not.toMatch(/^summary-/)
    expect(r2.newSummary!.throughId).not.toBe(r1.newSummary!.throughId) // moved forward

    // Round 3 — feed r2's summary back. Add more.
    const r3 = await prepareMessagesWithCompaction(
      [
        withId(u(big), 'm1'), withId(a(big), 'm2'),
        withId(u(big), 'm3'), withId(a(big), 'm4'),
        withId(u(big), 'm5'), withId(a(big), 'm6'),
        withId(u(big), 'm7'), withId(a(big), 'm8'),
        withId(u(big), 'm9'), withId(a(big), 'm10'),
        withId(u(big), 'm11'), withId(a(big), 'm12'),
      ],
      smallConfig,
      {
        summarizer: vi.fn(async () => 'r3 summary'),
        cachedSummary: { text: r2.newSummary!.text, throughId: r2.newSummary!.throughId },
      },
    )
    expect(r3.newSummary).toBeDefined()
    expect(r3.newSummary!.throughId).not.toMatch(/^summary-/)
    expect(r3.newSummary!.throughId).not.toBe(r2.newSummary!.throughId)
  })

  it('cached summary with stale throughId (no longer in history) is ignored gracefully', async () => {
    // Reproduces: a chat row's `compactedThroughId` points at a message
    // that's been deleted (e.g. cascade rerun), or whose id changed somehow.
    // We must not crash and we must not feed the stale summary forward.
    const summarizer = vi.fn(async (_msgs: ChatTurn[]) => 'fresh, no roll-forward')
    const big = 'x'.repeat(150)
    const msgs: ChatTurn[] = [
      withId(u(big), 'm1'), withId(a(big), 'm2'),
      withId(u(big), 'm3'), withId(a(big), 'm4'),
    ]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, {
      summarizer,
      cachedSummary: { text: 'STALE_CACHED_TEXT', throughId: 'm99-not-in-history' },
    })
    // Cache should have been ignored; over-budget triggers fresh summarize.
    expect(out.newSummary).toBeDefined()
    expect(out.newSummary!.text).toBe('fresh, no roll-forward')
    // The stale cache must NOT have been fed to the summarizer (would
    // mislead the new summary into preserving deleted context).
    const summarizerInput = summarizer.mock.calls[0]?.[0] ?? []
    const leakedStale = summarizerInput.some((m) => m.content?.includes('STALE_CACHED_TEXT'))
    expect(leakedStale).toBe(false)
  })

  it('after summarization, the older half is replaced — no leftover bulk in output', async () => {
    const summarizer = vi.fn(async () => 'compact')
    const big = 'x'.repeat(150)
    const msgs: ChatTurn[] = [
      withId(u(big), 'm1'), withId(a(big), 'm2'),
      withId(u(big), 'm3'), withId(a(big), 'm4'),
    ]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, { summarizer })
    const ids = out.messages.map((m) => m.id)
    expect(ids).not.toContain('m1')
    expect(ids).not.toContain('m2')
    expect(ids).toContain('m3')
    expect(ids).toContain('m4')
    expect(out.messages[0].role).toBe('system')
  })

  it('summarizer failure on a re-summarize round does not lose the cached summary (sliding window pins it)', async () => {
    // If the Haiku call fails, we fall through to applySlidingWindow.
    // applySlidingWindow pins system messages; the cached summary is
    // wrapped as a system message in `working`, so it must survive the
    // fallback. Otherwise users lose all prior compaction context on a
    // single transient summarizer error.
    // The fallback logs the failure via console.error by design — silence it
    // here (and assert it fired) so the intentional error doesn't look like a
    // real test failure in the output.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const summarizer = vi.fn(async () => { throw new Error('summarizer down') })
    const big = 'x'.repeat(150)
    const msgs: ChatTurn[] = [
      withId(u(big), 'm1'), withId(a(big), 'm2'),
      withId(u(big), 'm3'), withId(a(big), 'm4'),
      withId(u(big), 'm5'), withId(a(big), 'm6'),
    ]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, {
      summarizer,
      cachedSummary: { text: 'PIN_THIS_TEXT', throughId: 'm2' },
    })
    expect(errSpy).toHaveBeenCalled()
    expect(out.newSummary).toBeUndefined()
    const stillHasSummary = out.messages.some(
      (m) => m.role === 'system' && (m.content ?? '').includes('PIN_THIS_TEXT'),
    )
    expect(stillHasSummary).toBe(true)
    errSpy.mockRestore()
  })
})

// ============================================================================
// unwrapToolOutput — flattens v5's tagged ToolResultPart `output` shape.
// ============================================================================

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

// ============================================================================
// buildUiParts — converts SDK `response.messages` into our persisted parts.
// ============================================================================

describe('buildUiParts', () => {
  it('handles a plain text-only response', () => {
    const out = buildUiParts(asResponseMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ]))
    expect(out).toEqual([{ type: 'text', text: 'hi there' }])
  })

  it('handles a string-content assistant message (some providers emit this)', () => {
    const out = buildUiParts(asResponseMessages([
      { role: 'assistant', content: 'plain string' },
    ]))
    expect(out).toEqual([{ type: 'text', text: 'plain string' }])
  })

  it('pairs assistant tool-call with tool-message tool-result and unwraps output', () => {
    const out = buildUiParts(asResponseMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'querying' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'records.query', input: { collection: 'x' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'records.query', output: { type: 'json', value: { rows: 3 } } },
        ],
      },
    ]))
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
    const out = buildUiParts(asResponseMessages([
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
          { type: 'tool-result', toolCallId: 'c1', toolName: 't', output: { type: 'json', value: 'ok' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'after' }] },
    ]))
    expect(out.map((p) => (p as { type: string }).type)).toEqual([
      'text', 'tool-invocation', 'text',
    ])
  })

  it('drops orphan tool-calls that have no matching tool-result', () => {
    // Provider quirk / mid-step failure scenarios.
    const out = buildUiParts(asResponseMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'starting' },
          { type: 'tool-call', toolCallId: 'orphan', toolName: 't', input: {} },
        ],
      },
    ]))
    expect(out).toEqual([{ type: 'text', text: 'starting' }])
  })

  it('maps an error-tagged tool result to {success:false, error}', () => {
    const out = buildUiParts(asResponseMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 't', input: {} }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 't', output: { type: 'error-text', value: 'denied' } },
        ],
      },
    ]))
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
    const out = buildUiParts(asResponseMessages([
      { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'text', text: 'kept' }] },
    ]))
    expect(out).toEqual([{ type: 'text', text: 'kept' }])
  })
})

