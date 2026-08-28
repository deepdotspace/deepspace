import { describe, expect, it } from 'vitest'
import {
  applySlidingWindow,
  capToolResultSize,
  truncateOldToolResults,
  type ChatTurn,
} from '../chat-context'

interface ToolInvocationPart {
  toolInvocation: { state?: string; result: Record<string, unknown> & { _truncated?: boolean } }
}

function readToolInvocation(part: unknown): ToolInvocationPart['toolInvocation'] {
  return (part as ToolInvocationPart).toolInvocation
}

function userTurn(content: string): ChatTurn {
  return { role: 'user', content }
}

function assistantTurn(content: string, parts?: unknown[]): ChatTurn {
  return { role: 'assistant', content, parts }
}

function systemTurn(content: string, id?: string): ChatTurn {
  return { role: 'system', content, id }
}

function toolPart(toolName: string, result: unknown, state: 'call' | 'result' = 'result') {
  return { type: 'tool-invocation', toolInvocation: { toolName, state, result } }
}

describe('applySlidingWindow', () => {
  it('returns unchanged when under cap', () => {
    const msgs = [userTurn('hi'), assistantTurn('there')]
    expect(applySlidingWindow(msgs, 10_000, 2)).toBe(msgs)
  })

  it('drops oldest first until under cap', () => {
    const msgs = [
      userTurn('A'.repeat(100)),
      userTurn('B'.repeat(100)),
      userTurn('C'.repeat(100)),
      userTurn('D'.repeat(50)),
    ]
    const out = applySlidingWindow(msgs, 200, 1)
    expect(out.map((m) => m.content[0])).toEqual(['C', 'D'])
  })

  it('respects minKept even when still over cap', () => {
    const msgs = [userTurn('A'.repeat(500)), userTurn('B'.repeat(500)), userTurn('C'.repeat(500))]
    const out = applySlidingWindow(msgs, 100, 2)
    expect(out).toHaveLength(2)
  })

  it('preserves system messages and drops user/assistant first', () => {
    const msgs = [
      systemTurn('summary pinned', 'summary-m1'),
      userTurn('A'.repeat(500)),
      userTurn('B'.repeat(500)),
      userTurn('C'.repeat(100)),
    ]
    const out = applySlidingWindow(msgs, 300, 1)
    // Summary still present; oldest non-system was dropped first.
    expect(out.find((m) => m.role === 'system')).toBeDefined()
    expect(out[0].role).toBe('system')
    expect(out.map((m) => m.content[0])).not.toContain('A')
  })

  it('exits cleanly when only system messages remain (cannot drop below pin)', () => {
    // Two system messages, both large. Cap forces eviction but every message
    // is system → findIndex returns -1 → loop must break, not infinite-loop.
    const msgs: ChatTurn[] = [
      systemTurn('A'.repeat(500), 'sys-1'),
      systemTurn('B'.repeat(500), 'sys-2'),
    ]
    const out = applySlidingWindow(msgs, 100, 0)
    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('system')
    expect(out[1].role).toBe('system')
  })
})

describe('capToolResultSize', () => {
  it('returns input unchanged under cap', () => {
    const payload = { data: [1, 2, 3] }
    expect(capToolResultSize(payload, 1000)).toBe(payload)
  })

  it('measures the cap in UTF-8 bytes, not UTF-16 length', () => {
    // 1,000 leaf emoji = 2,000 UTF-16 units but ~4,000 UTF-8 bytes. A cap of
    // 3,000 bytes must engage even though the string length is under it —
    // consumers (the agent tool route, HTTP bodies) all measure bytes.
    const big = { data: '🍃'.repeat(1000) }
    const out = capToolResultSize(big, 3000) as Record<string, unknown>
    expect(out.success).toBe(false)
    expect(out.truncated).toBe(true)
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
    expect(out.returned as number).toBeGreaterThan(0)
    expect(out.returned as number).toBeLessThan(200)
    // The returned page actually fits under the cap.
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3000)
    // Leading items, in order, are preserved.
    expect((out.records as { id: number }[])[0].id).toBe(0)
  })

  it('degrades the records.query tool-result shape, preserving success:true', () => {
    const records = Array.from({ length: 300 }, (_, i) => ({ id: i, blob: 'z'.repeat(150) }))
    const result = { success: true, data: { records, count: records.length } }
    const out = capToolResultSize(result, 4000) as {
      success: boolean
      data: Record<string, unknown>
    }
    // success stays true at the top level — app code reading result.data.records
    // gets a real (partial) page, not a failed result.
    expect(out.success).toBe(true)
    expect(out.data.truncated).toBe(true)
    expect(out.data.total).toBe(300)
    expect((out.data.records as unknown[]).length).toBe(out.data.returned)
    expect(out.data.returned as number).toBeGreaterThan(0)
    expect(out.data.returned as number).toBeLessThan(300)
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4000)
  })

  it('falls back to the error when even an empty list cannot fit (bloat in siblings)', () => {
    // Tiny array, but a huge sibling field — trimming the array can't help, so
    // we still get the informative error rather than a bogus "empty page".
    const out = capToolResultSize({ records: [{ id: 1 }], note: 'q'.repeat(5000) }, 1000) as Record<
      string,
      unknown
    >
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

describe('truncateOldToolResults', () => {
  it('keeps the last N tool results intact', () => {
    const msgs: ChatTurn[] = [
      assistantTurn('one', [toolPart('search', { hits: 1 })]),
      assistantTurn('two', [toolPart('search', { hits: 2 })]),
      assistantTurn('three', [toolPart('search', { hits: 3 })]),
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
      assistantTurn('first', [toolPart('search', { success: false, error: 'boom' })]),
      assistantTurn('next', []),
      assistantTurn('next', []),
      assistantTurn('next', []),
    ]
    const out = truncateOldToolResults(msgs, 1)
    const result = readToolInvocation(out[0].parts![0]).result
    expect(result.success).toBe(false)
    expect(result.error).toBe('boom')
  })

  it('preserves assistant text around truncated results', () => {
    const msgs: ChatTurn[] = [
      assistantTurn('reasoning text', [toolPart('search', { hits: 1 })]),
      assistantTurn('newer', [toolPart('search', { hits: 2 })]),
    ]
    const out = truncateOldToolResults(msgs, 1)
    expect(out[0].content).toBe('reasoning text')
  })

  it('passes through assistant rows with non-array parts', () => {
    const msgs: ChatTurn[] = [
      // parts is undefined — common for plain-text assistant rows.
      { role: 'assistant', content: 'plain text 1' },
      // parts intentionally non-array — defensive against bad rows.
      { role: 'assistant', content: 'plain text 2', parts: 'not-an-array' as unknown as unknown[] },
      assistantTurn('newer', [toolPart('search', { hits: 99 })]),
    ]
    const out = truncateOldToolResults(msgs, 1)
    expect(out[0]).toEqual(msgs[0])
    expect(out[1]).toEqual(msgs[1])
    expect(readToolInvocation(out[2].parts![0]).result.hits).toBe(99)
  })

  it('leaves tool-invocation in state:call alone (not yet a result)', () => {
    const msgs: ChatTurn[] = [
      assistantTurn('mid-stream', [toolPart('search', undefined, 'call')]),
      assistantTurn('newer', [toolPart('search', { hits: 1 })]),
      assistantTurn('newer', [toolPart('search', { hits: 2 })]),
    ]
    const out = truncateOldToolResults(msgs, 1)
    // call-state survives untouched (no result to redact).
    const inv = readToolInvocation(out[0].parts![0])
    expect(inv.state).toBe('call')
    expect(inv.result).toBeUndefined()
  })

  it('returns empty array unchanged', () => {
    expect(truncateOldToolResults([], 5)).toEqual([])
  })

  it('returns user-only history unchanged (no assistants to truncate)', () => {
    const msgs: ChatTurn[] = [userTurn('a'), userTurn('b'), userTurn('c')]
    const out = truncateOldToolResults(msgs, 1)
    expect(out).toEqual(msgs)
  })

  it('keepRecent=0 truncates ALL assistant tool results', () => {
    // Edge of the protectedStart formula: when keepRecent is 0, every
    // assistant turn precedes the (nonexistent) protected window.
    const msgs: ChatTurn[] = [
      assistantTurn('a', [toolPart('search', { hits: 1 })]),
      assistantTurn('b', [toolPart('search', { hits: 2 })]),
    ]
    const out = truncateOldToolResults(msgs, 0)
    expect(readToolInvocation(out[0].parts![0]).result._truncated).toBe(true)
    expect(readToolInvocation(out[1].parts![0]).result._truncated).toBe(true)
  })
})
