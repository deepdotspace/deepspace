import type { ToolSet } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import type { DeepSpaceAIEnv } from '../ai'

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: streamTextMock,
}))

vi.mock('../ai', () => ({
  createDeepSpaceAI: () => () => ({}),
}))

import { streamDeepSpaceAgent } from '../agent'

describe('streamDeepSpaceAgent tool-call limit', () => {
  for (const profile of ['application', 'documentation'] as const) {
    it(`executes at most twenty ${profile} tools and then forces synthesis`, async () => {
      streamTextMock.mockClear()
      streamTextMock.mockReturnValue({})
      const execute = vi.fn(async () => ({ results: [] }))
      const tools =
        profile === 'documentation'
          ? {
              documentation_search: { execute },
              documentation_read: { execute },
            }
          : { records_search: { execute } }

      streamDeepSpaceAgent({} as DeepSpaceAIEnv, {
        profile,
        prompt: 'Find the answer',
        tools: tools as unknown as ToolSet,
      })

      const options = streamTextMock.mock.calls[0]?.[0] as {
        tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>
        prepareStep: (context: {
          steps: Array<{ toolCalls: unknown[] }>
        }) => Promise<unknown>
      }
      const run = Object.values(options.tools)[0]?.execute
      expect(run).toBeTypeOf('function')
      for (let call = 0; call < 20; call++) await run?.({ query: 'auth' }, {})
      expect(await run?.({ query: 'auth' }, {})).toEqual({
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
  }
})
