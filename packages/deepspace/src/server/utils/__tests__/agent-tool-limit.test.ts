import type { ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import type { DeepSpaceAIEnv } from '../ai'

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }))

vi.mock('ai', async (importOriginal) => ({
  ...await importOriginal<typeof import('ai')>(),
  streamText: streamTextMock,
}))

vi.mock('../ai', () => ({
  createDeepSpaceAI: () => () => ({}),
}))

import { streamDeepSpaceAgent } from '../agent'

describe('streamDeepSpaceAgent tool-call limit', () => {
  it('executes at most twenty docs tools and then forces synthesis', async () => {
    streamTextMock.mockReturnValue({})
    const execute = vi.fn(async () => ({ results: [] }))
    const tools = {
      docs_search: { execute },
      docs_read: { execute },
    } as unknown as ToolSet

    streamDeepSpaceAgent({} as DeepSpaceAIEnv, {
      profile: 'documentation',
      prompt: 'Find the answer',
      tools,
    })

    const options = streamTextMock.mock.calls[0]?.[0] as {
      tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>
      prepareStep: (context: { steps: Array<{ toolCalls: unknown[] }> }) => Promise<unknown>
    }
    const search = options.tools.docs_search?.execute
    expect(search).toBeTypeOf('function')
    for (let call = 0; call < 20; call++) await search?.({ query: 'auth' }, {})
    expect(await search?.({ query: 'auth' }, {})).toEqual({
      error: 'The agent tool-call limit of 20 has been reached',
    })
    expect(execute).toHaveBeenCalledTimes(20)

    const nineteenCalls = Array.from({ length: 19 }, () => ({ toolCalls: [{}] }))
    const twentyCalls = [...nineteenCalls, { toolCalls: [{}] }]
    expect(await options.prepareStep({ steps: nineteenCalls })).toBeUndefined()
    expect(await options.prepareStep({ steps: twentyCalls })).toEqual({
      activeTools: [],
      toolChoice: 'none',
    })
  })
})
