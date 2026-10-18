import type { ModelMessage, ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import type { DeepSpaceAIEffort } from '../../../shared/ai-models'
import type { DeepSpaceAIEnv } from '../ai'

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: streamTextMock,
}))

vi.mock('../ai', () => ({
  createDeepSpaceAI: () => () => ({}),
}))

import {
  DeepSpaceAgentEffortError,
  DeepSpaceAgentToolLimitError,
  streamDeepSpaceAgent,
} from '../agent'
import { DEFAULT_CONTEXT_CONFIG } from '../chat-context'

type LimitOptions = {
  stopWhen: (context: { steps: unknown[] }) => boolean | Promise<boolean>
  tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>
  prepareStep: (context: {
    steps: Array<{ toolCalls: unknown[] }>
    messages: ModelMessage[]
  }) => Promise<{ activeTools?: unknown; toolChoice?: unknown; messages?: ModelMessage[] } | undefined>
}

function startAgent(
  profile: 'application' | 'documentation',
  tools: ToolSet,
  extra: { maxToolCalls?: number; prepareStep?: unknown } = {},
): LimitOptions {
  streamTextMock.mockClear()
  streamTextMock.mockReturnValue({})
  streamDeepSpaceAgent({} as DeepSpaceAIEnv, {
    profile,
    prompt: 'Find the answer',
    tools,
    ...(extra as object),
  })
  return streamTextMock.mock.calls[0]?.[0] as LimitOptions
}

const turn: ModelMessage[] = [{ role: 'user', content: 'Find the answer' }]
const stepsWith = (calls: number) => Array.from({ length: calls }, () => ({ toolCalls: [{}] }))

describe('streamDeepSpaceAgent tool-call limit', () => {
  for (const profile of ['application', 'documentation'] as const) {
    it(`executes at most twenty ${profile} tools by default, then asks for a reply`, async () => {
      const execute = vi.fn(async () => ({ results: [] }))
      const tools =
        profile === 'documentation'
          ? { documentation_search: { execute }, documentation_read: { execute } }
          : { records_search: { execute } }
      const options = startAgent(profile, tools as unknown as ToolSet)

      const run = Object.values(options.tools)[0]?.execute
      expect(run).toBeTypeOf('function')
      for (let call = 0; call < 20; call++) await run?.({ query: 'auth' }, {})
      expect(await run?.({ query: 'auth' }, {})).toEqual({
        error: 'The agent tool-call limit of 20 has been reached',
      })
      expect(execute).toHaveBeenCalledTimes(20)
      expect(await options.stopWhen({ steps: stepsWith(20) })).toBe(false)
      expect(await options.stopWhen({ steps: stepsWith(21) })).toBe(true)

      expect(await options.prepareStep({ steps: stepsWith(19), messages: turn })).toBeUndefined()
      const final = await options.prepareStep({ steps: stepsWith(20), messages: turn })
      expect(final).toMatchObject({ activeTools: [], toolChoice: 'none' })
      expect(final?.messages?.slice(0, -1)).toEqual(turn)
      expect(final?.messages?.at(-1)).toMatchObject({
        role: 'user',
        content: expect.stringContaining('You have used all 20 tool calls'),
      })
    })
  }

  it('lets an application agent set its own limit', async () => {
    const execute = vi.fn(async () => ({}))
    const options = startAgent('application', { records_update: { execute } } as unknown as ToolSet, {
      maxToolCalls: 50,
    })
    for (let call = 0; call < 51; call++) await options.tools.records_update.execute({}, {})
    expect(execute).toHaveBeenCalledTimes(50)
    expect(await options.prepareStep({ steps: stepsWith(49), messages: turn })).toBeUndefined()
    const final = await options.prepareStep({ steps: stepsWith(50), messages: turn })
    expect(final?.messages?.at(-1)?.content).toContain('all 50 tool calls')
  })

  it("builds the final step on the caller's own prepareStep messages", async () => {
    const trimmed: ModelMessage[] = [{ role: 'user', content: 'trimmed history' }]
    const options = startAgent('application', {} as ToolSet, {
      prepareStep: async () => ({ messages: trimmed }),
    })
    const final = await options.prepareStep({ steps: stepsWith(20), messages: turn })
    expect(final?.messages?.slice(0, -1)).toEqual(trimmed)
  })

  it.each([0, 101, 2.5, '30'])('rejects maxToolCalls %j', (value) => {
    expect(() => startAgent('application', {} as ToolSet, { maxToolCalls: value as number })).toThrow(
      DeepSpaceAgentToolLimitError,
    )
  })

  it('keeps the documentation limit fixed', () => {
    expect(() => startAgent('documentation', {} as ToolSet, { maxToolCalls: 40 })).toThrow(
      'does not accept a maxToolCalls override',
    )
  })
})

describe('streamDeepSpaceAgent tool results', () => {
  const cap = DEFAULT_CONTEXT_CONFIG.toolResultCap
  const runTool = (execute: (...args: unknown[]) => unknown) => {
    streamTextMock.mockClear()
    streamTextMock.mockReturnValue({})
    streamDeepSpaceAgent({} as DeepSpaceAIEnv, {
      profile: 'application',
      prompt: 'Summarize my notes',
      tools: { notes: { execute } } as unknown as ToolSet,
    })
    const options = streamTextMock.mock.calls[0]?.[0] as {
      tools: Record<string, { execute: (...args: unknown[]) => unknown }>
    }
    return options.tools.notes.execute({}, {})
  }

  it("caps an app-defined tool's output where it reaches the model", async () => {
    const records = Array.from({ length: 400 }, (_, index) => ({ id: index, note: 'x'.repeat(200) }))
    const output = (await runTool(async () => ({ records }))) as {
      records: unknown[]
      truncated: boolean
      total: number
    }
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(cap)
    expect(output).toMatchObject({ truncated: true, total: 400 })
    expect(output.records.length).toBeGreaterThan(0)
  })

  it('passes a small output through unchanged', async () => {
    const result = { records: [{ id: 1 }] }
    expect(await runTool(async () => result)).toBe(result)
  })

  it("returns a streaming tool's iterable as is, so the AI SDK still streams it", () => {
    async function* stream() {
      yield 'partial'
    }
    const iterable = stream()
    expect(runTool(() => iterable)).toBe(iterable)
  })
})

describe('streamDeepSpaceAgent effort', () => {
  const providerOptionsFor = (modelId: string, effort?: DeepSpaceAIEffort) => {
    streamTextMock.mockClear()
    streamTextMock.mockReturnValue({})
    streamDeepSpaceAgent({} as DeepSpaceAIEnv, {
      profile: 'application',
      modelId,
      prompt: 'Plan my week',
      ...(effort ? { effort } : {}),
    })
    return (streamTextMock.mock.calls[0]?.[0] as { providerOptions: unknown }).providerOptions
  }

  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])(
    'runs %s at medium by default',
    (modelId) => {
      expect(providerOptionsFor(modelId)).toEqual({ anthropic: { effort: 'medium' } })
    },
  )

  it("keeps an older model's own default", () => {
    expect(providerOptionsFor('claude-sonnet-5')).toEqual({ anthropic: { effort: 'high' } })
  })

  it("uses the app's effort over the model default", () => {
    expect(providerOptionsFor('claude-sonnet-5-5', 'max')).toEqual({ anthropic: { effort: 'max' } })
    expect(providerOptionsFor('claude-haiku-5-5', 'low')).toEqual({ anthropic: { effort: 'low' } })
  })

  it('rejects an unknown effort before streaming', () => {
    expect(() => providerOptionsFor('claude-sonnet-5-5', 'adaptive' as DeepSpaceAIEffort)).toThrow(
      DeepSpaceAgentEffortError,
    )
    expect(streamTextMock).not.toHaveBeenCalled()
  })

  it('ignores effort on models without the setting', () => {
    expect(providerOptionsFor('claude-haiku-4-5', 'high')).toBeUndefined()
    expect(providerOptionsFor('gpt-6-sol', 'high')).toEqual({ openai: { reasoningEffort: 'none' } })
  })
})
