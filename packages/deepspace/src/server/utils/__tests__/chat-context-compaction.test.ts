import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CONTEXT_CONFIG,
  prepareMessagesWithCompaction,
  type ChatContextConfig,
  type ChatTurn,
} from '../chat-context'

function userTurn(content: string): ChatTurn {
  return { role: 'user', content }
}

function assistantTurn(content: string): ChatTurn {
  return { role: 'assistant', content }
}

function withId(turn: ChatTurn, id: string): ChatTurn {
  return { ...turn, id }
}

describe('prepareMessagesWithCompaction', () => {
  const smallConfig: ChatContextConfig = {
    ...DEFAULT_CONTEXT_CONFIG,
    contextBudget: 2000,
    keepRecentToolResults: 2,
    minKept: 2,
  }

  it('returns input unchanged when under budget; summarizer not called', async () => {
    const summarizer = vi.fn(async () => 'mock summary text')
    const msgs = [userTurn('hi'), assistantTurn('hello')]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, { summarizer })
    expect(out.messages).toEqual(msgs)
    expect(out.newSummary).toBeUndefined()
    expect(summarizer).not.toHaveBeenCalled()
  })

  it('summarizes older half when over budget with no cached summary', async () => {
    const summarizer = vi.fn(async () => 'mock summary text')
    const big = 'x'.repeat(800)
    const msgs: ChatTurn[] = [
      withId(userTurn(big), 'm1'),
      withId(assistantTurn(big), 'm2'),
      withId(userTurn(big), 'm3'),
      withId(assistantTurn(big), 'm4'),
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
      withId(userTurn(big), 'm1'),
      withId(assistantTurn(big), 'm2'),
      withId(userTurn(big), 'm3'),
      withId(assistantTurn(big), 'm4'),
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
      withId(userTurn(big), 'm1'),
      withId(assistantTurn(big), 'm2'),
      withId(userTurn(big), 'm3'),
      withId(assistantTurn(big), 'm4'),
      withId(userTurn(big), 'm5'),
      withId(assistantTurn(big), 'm6'),
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
      [withId(userTurn(big), 'm5'), withId(assistantTurn(big), 'm6')],
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
      withId(userTurn(big), 'm1'),
      withId(assistantTurn(big), 'm2'),
      withId(userTurn(big), 'm3'),
      withId(assistantTurn(big), 'm4'),
    ]
    const out = await prepareMessagesWithCompaction(msgs, smallConfig, { summarizer })
    expect(summarizer).toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    expect(out.newSummary).toBeUndefined()
    expect(out.messages.length).toBeGreaterThanOrEqual(smallConfig.minKept)
    errSpy.mockRestore()
  })

  it('returns empty input unchanged', async () => {
    const summarizer = vi.fn(async () => 'unused')
    const out = await prepareMessagesWithCompaction([], DEFAULT_CONTEXT_CONFIG, { summarizer })
    expect(out.messages).toEqual([])
    expect(out.newSummary).toBeUndefined()
    expect(summarizer).not.toHaveBeenCalled()
  })

  it('ignores a stale cached summary and anchors a fresh summary on a real message id', async () => {
    const summarizer = vi.fn(async () => 'fresh summary')
    const big = 'x'.repeat(900)
    const out = await prepareMessagesWithCompaction(
      [{ role: 'user', content: big, id: 'm6' }],
      { ...DEFAULT_CONTEXT_CONFIG, contextBudget: 100, minKept: 1, keepRecentToolResults: 2 },
      { summarizer, cachedSummary: { text: 'cached', throughId: 'NEVER_PRESENT' } },
    )
    expect(summarizer).toHaveBeenCalledTimes(1)
    expect(out.newSummary).toEqual({ text: 'fresh summary', throughId: 'm6' })
  })
})

describe('prepareMessagesWithCompaction — multi-round summaries', () => {
  const smallConfig: ChatContextConfig = {
    ...DEFAULT_CONTEXT_CONFIG,
    contextBudget: 500,
    keepRecentToolResults: 2,
    minKept: 2,
  }

  it('feeds the prior summary into the summarizer so the new summary can roll it forward', async () => {
    let captured: ChatTurn[] | null = null
    const summarizer = vi.fn(async (m: ChatTurn[]) => {
      captured = m
      return 'fresh rolled-up summary'
    })
    const big = 'x'.repeat(150)
    const msgs: ChatTurn[] = [
      withId(userTurn(big), 'm1'),
      withId(assistantTurn(big), 'm2'),
      withId(userTurn(big), 'm3'),
      withId(assistantTurn(big), 'm4'),
      withId(userTurn(big), 'm5'),
      withId(assistantTurn(big), 'm6'),
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
        withId(userTurn(big), 'm1'),
        withId(assistantTurn(big), 'm2'),
        withId(userTurn(big), 'm3'),
        withId(assistantTurn(big), 'm4'),
      ],
      smallConfig,
      { summarizer: vi.fn(async () => 'r1 summary') },
    )
    expect(r1.newSummary).toBeDefined()
    expect(r1.newSummary!.throughId).not.toMatch(/^summary-/)

    // Round 2 — feed r1's summary back as cached. Add more messages.
    const r2 = await prepareMessagesWithCompaction(
      [
        withId(userTurn(big), 'm1'),
        withId(assistantTurn(big), 'm2'),
        withId(userTurn(big), 'm3'),
        withId(assistantTurn(big), 'm4'),
        withId(userTurn(big), 'm5'),
        withId(assistantTurn(big), 'm6'),
        withId(userTurn(big), 'm7'),
        withId(assistantTurn(big), 'm8'),
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
        withId(userTurn(big), 'm1'),
        withId(assistantTurn(big), 'm2'),
        withId(userTurn(big), 'm3'),
        withId(assistantTurn(big), 'm4'),
        withId(userTurn(big), 'm5'),
        withId(assistantTurn(big), 'm6'),
        withId(userTurn(big), 'm7'),
        withId(assistantTurn(big), 'm8'),
        withId(userTurn(big), 'm9'),
        withId(assistantTurn(big), 'm10'),
        withId(userTurn(big), 'm11'),
        withId(assistantTurn(big), 'm12'),
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
      withId(userTurn(big), 'm1'),
      withId(assistantTurn(big), 'm2'),
      withId(userTurn(big), 'm3'),
      withId(assistantTurn(big), 'm4'),
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
      withId(userTurn(big), 'm1'),
      withId(assistantTurn(big), 'm2'),
      withId(userTurn(big), 'm3'),
      withId(assistantTurn(big), 'm4'),
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
    const summarizer = vi.fn(async () => {
      throw new Error('summarizer down')
    })
    const big = 'x'.repeat(150)
    const msgs: ChatTurn[] = [
      withId(userTurn(big), 'm1'),
      withId(assistantTurn(big), 'm2'),
      withId(userTurn(big), 'm3'),
      withId(assistantTurn(big), 'm4'),
      withId(userTurn(big), 'm5'),
      withId(assistantTurn(big), 'm6'),
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
