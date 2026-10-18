import { jsonSchema, tool, type ToolSet } from 'ai'
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'
import type { DeepSpaceAIEnv } from '../ai'

const state: { model?: MockLanguageModelV4 } = {}

vi.mock('../ai', () => ({
  createDeepSpaceAI: () => () => state.model,
}))

import { streamDeepSpaceAgent } from '../agent'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function modelStep(parts: unknown[], finish: 'tool-calls' | 'stop') {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      ...parts,
      { type: 'finish', finishReason: { unified: finish, raw: finish }, usage },
    ]),
  }
}

const toolCall = (id: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'work', input: '{}' })

describe('streamDeepSpaceAgent tool-call limit in the AI SDK loop', () => {
  it('stops parallel calls at the limit and asks for a reply, over the caller prepareStep', async () => {
    const calls: Array<{ tools?: unknown; toolChoice?: unknown; prompt: Array<{ role: string; content: unknown }> }> = []
    state.model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls.push(options as (typeof calls)[number])
        if (calls.length <= 2) {
          return modelStep([toolCall(`a${calls.length}`), toolCall(`b${calls.length}`)], 'tool-calls') as never
        }
        return modelStep(
          [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'Did three of four.' },
            { type: 'text-end', id: 't' },
          ],
          'stop',
        ) as never
      },
    })
    const execute = vi.fn(async () => ({ ok: true }))

    const { result } = streamDeepSpaceAgent({} as DeepSpaceAIEnv, {
      profile: 'application',
      maxToolCalls: 3,
      prompt: 'Update everything',
      tools: { work: tool({ inputSchema: jsonSchema({ type: 'object' }), execute }) } as ToolSet,
      prepareStep: async ({ stepNumber }) =>
        stepNumber === 2 ? { activeTools: ['work'], toolChoice: 'required' as const } : undefined,
    })

    expect(await result.text).toBe('Did three of four.')
    expect(execute).toHaveBeenCalledTimes(3)
    expect(calls).toHaveLength(3)
    const final = calls[2]
    expect(final.tools).toBeUndefined()
    expect(final.toolChoice).toEqual({ type: 'none' })
    expect(JSON.stringify(final.prompt.at(-1))).toContain('You have used all 3 tool calls')
    const saved = (await result.steps).flatMap((step) => step.response.messages)
    expect(JSON.stringify(saved)).not.toContain('You have used all')
  })
})
