/**
 * createDeepSpaceAI against the real AI SDK providers: the request each one
 * sends to the proxy for a plain call. Only the proxy's HTTP answer is faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText, tool } from 'ai'
import { z } from 'zod'
import { createDeepSpaceAI } from '../ai'

const ENV = { API_WORKER_URL: 'https://api.example.com', APP_OWNER_JWT: 'owner-jwt' }

describe('createDeepSpaceAI with the real providers', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  const lastBody = () => JSON.parse(String((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body))

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  describe('Anthropic max_tokens', () => {
    const reply = () =>
      Response.json({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 }, content: [{ type: 'text', text: 'hi' }],
      })

    it('defaults to 64K instead of the model ceiling', async () => {
      fetchSpy.mockResolvedValueOnce(reply())
      await generateText({ model: createDeepSpaceAI(ENV, 'anthropic')('claude-opus-5-5'), prompt: 'hi' })
      expect(lastBody().max_tokens).toBe(64_000)
    })

    it('keeps the caller maxOutputTokens, above or below the default', async () => {
      const ai = createDeepSpaceAI(ENV, 'anthropic')
      for (const maxOutputTokens of [1_000, 100_000]) {
        fetchSpy.mockResolvedValueOnce(reply())
        await generateText({ model: ai('claude-opus-5-5'), prompt: 'hi', maxOutputTokens })
        expect(lastBody().max_tokens).toBe(maxOutputTokens)
      }
    })
  })

  it("sends reasoning_effort none for GPT-6 tool calls, which @ai-sdk/openai drops", async () => {
    fetchSpy.mockResolvedValueOnce(
      Response.json({
        id: 'chatcmpl_1', object: 'chat.completion', created: 0, model: 'gpt-6-sol',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
    )
    await generateText({
      model: createDeepSpaceAI(ENV, 'openai')('gpt-6-sol'),
      tools: { t: tool({ inputSchema: z.object({}), execute: async () => ({}) }) },
      providerOptions: { openai: { reasoningEffort: 'none' } },
      prompt: 'hi',
    })
    expect(lastBody()).toMatchObject({ model: 'gpt-6-sol', reasoning_effort: 'none' })
    expect(lastBody().tools).toHaveLength(1)
  })
})
