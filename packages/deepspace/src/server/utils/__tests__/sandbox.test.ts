/**
 * The sandbox helpers against the real @ai-sdk/anthropic provider: what the
 * Messages request carries (tool, allowed_callers, container_upload,
 * container reuse, identity headers) and what `sandboxOutputs` reads back.
 * Only the proxy's HTTP answer is faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateText, isStepCount, tool } from 'ai'
import { z } from 'zod'
import { createDeepSpaceAI } from '../ai'
import {
  SandboxFileError,
  callableFromSandbox,
  codeExecutionTool,
  forwardSandboxContainer,
  reuseSandbox,
  sandboxFiles,
  sandboxOutputs,
  sandboxUpload,
} from '../sandbox'

const ENV = {
  API_WORKER_URL: 'https://api.example.com',
  APP_OWNER_JWT: 'owner-jwt',
  DEEPSPACE_APP_ID: 'app_01KZ707G1PSW064VMBAM7NW1AQ',
  APP_IDENTITY_TOKEN: 'identity-token',
}

const USAGE = { input_tokens: 10, output_tokens: 5 }

function message(content: unknown[], extra: Record<string, unknown> = {}) {
  return Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    usage: USAGE,
    container: { id: 'container_1', expires_at: '2026-09-23T22:00:00Z' },
    content,
    ...extra,
  })
}

const CODE_RESULT = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'bash_code_execution', input: { command: 'python make.py' } },
  {
    type: 'bash_code_execution_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: {
      type: 'bash_code_execution_result',
      stdout: '',
      stderr: '',
      return_code: 0,
      content: [{ type: 'bash_code_execution_output', file_id: 'file_made' }],
    },
  },
  { type: 'text', text: 'Done.' },
]

describe('sandbox helpers with the Anthropic provider', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  const bodies = () => fetchSpy.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)))

  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends the tool, the upload and the saved container, and reads back the outputs', async () => {
    fetchSpy.mockResolvedValueOnce(message(CODE_RESULT))
    const ai = createDeepSpaceAI(ENV, 'anthropic')

    const result = await generateText({
      model: ai('claude-sonnet-5'),
      tools: { code_execution: codeExecutionTool() },
      providerOptions: reuseSandbox('container_prev'),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Chart this sheet' },
          sandboxUpload({ id: 'file_in', filename: 'leads.xlsx', mime_type: 'application/vnd.ms-excel' }),
        ],
      }],
    })

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/api/proxy/anthropic/v1/messages')
    const headers = new Headers(init.headers)
    expect(headers.get('x-app-id')).toBe(ENV.DEEPSPACE_APP_ID)
    expect(headers.get('x-auth-token')).toBe('owner-jwt')

    const [body] = bodies()
    expect(body.tools).toEqual([{ type: 'code_execution_20260120', name: 'code_execution' }])
    expect(body.container).toBe('container_prev')
    expect(body.messages[0].content).toContainEqual({ type: 'container_upload', file_id: 'file_in' })

    expect(sandboxOutputs(result.steps)).toEqual({ containerId: 'container_1', fileIds: ['file_made'] })
  })

  it('lets sandbox code call an app tool and keeps the container across the round trip', async () => {
    const lookup = vi.fn(async ({ q }: { q: string }) => `rows for ${q}`)
    fetchSpy
      .mockResolvedValueOnce(message([
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution', input: { code: 'crm_query(q="acme")' } },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'crm_query',
          input: { q: 'acme' },
          caller: { type: 'code_execution_20260120', tool_id: 'srvtoolu_1' },
        },
      ], { stop_reason: 'tool_use' }))
      .mockResolvedValueOnce(message([
        {
          type: 'code_execution_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: { type: 'code_execution_result', stdout: 'rows for acme', stderr: '', return_code: 0, content: [] },
        },
        { type: 'text', text: 'Found them.' },
      ]))

    const ai = createDeepSpaceAI(ENV, 'anthropic')
    await generateText({
      model: ai('claude-sonnet-5'),
      tools: {
        code_execution: codeExecutionTool(),
        crm_query: callableFromSandbox(tool({
          description: 'Query the CRM',
          inputSchema: z.object({ q: z.string() }),
          execute: lookup,
        })),
      },
      prepareStep: forwardSandboxContainer,
      stopWhen: isStepCount(3),
      prompt: 'Find acme',
    })

    expect(lookup).toHaveBeenCalledWith({ q: 'acme' }, expect.anything())
    const [first, second] = bodies()
    expect(first.tools).toContainEqual(expect.objectContaining({
      name: 'crm_query',
      allowed_callers: ['direct', 'code_execution_20260120'],
    }))
    // The paused call must be answered in the same container, with the caller replayed.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(second.container).toBe('container_1')
    const replayed = second.messages.flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : []))
    expect(replayed).toContainEqual(expect.objectContaining({
      type: 'tool_use',
      id: 'toolu_1',
      caller: { type: 'code_execution_20260120', tool_id: 'srvtoolu_1' },
    }))
  })
})

describe('reuseSandbox', () => {
  it('is a no-op without a saved container', () => {
    expect(reuseSandbox(null)).toBeUndefined()
    expect(reuseSandbox(undefined)).toBeUndefined()
  })
})

describe('sandboxFiles', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(async () => Response.json({ type: 'file', id: 'file_1', filename: 'a.csv' }))
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uploads through the proxy with auth, identity and scope', async () => {
    const files = sandboxFiles(ENV, { authToken: 'user-jwt', scope: 'app' })
    const meta = await files.upload(new Blob(['a,b']), { filename: 'a.csv', expiresInSeconds: 3_600 })

    expect(meta.id).toBe('file_1')
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/api/proxy/anthropic/v1/files')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('x-auth-token')).toBe('user-jwt')
    expect(headers.get('x-app-identity-token')).toBe('identity-token')
    expect(headers.get('x-deepspace-sandbox-scope')).toBe('app')
    const form = init.body as FormData
    expect((form.get('file') as File).name).toBe('a.csv')
    expect(form.get('expires_in_seconds')).toBe('3600')
  })

  it('addresses one file and passes list paging through', async () => {
    const files = sandboxFiles(ENV)
    await files.download('file_1')
    await files.list({ limit: 5, page: 'page_1.file_1' })
    await files.delete('file_1')
    expect(fetchSpy.mock.calls.map(([url, init]) => [url, (init as RequestInit).method ?? 'GET'])).toEqual([
      ['https://api.example.com/api/proxy/anthropic/v1/files/file_1/content', 'GET'],
      ['https://api.example.com/api/proxy/anthropic/v1/files?limit=5&page=page_1.file_1', 'GET'],
      ['https://api.example.com/api/proxy/anthropic/v1/files/file_1', 'DELETE'],
    ])
  })

  it('raises the proxy error with its status', async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ error: 'Not found' }, { status: 404 }))
    const error = await sandboxFiles(ENV).get('file_other').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxFileError)
    expect(error).toMatchObject({ status: 404, message: expect.stringContaining('Not found') })
  })

  it('needs a filename for a bare Blob', async () => {
    await expect(sandboxFiles(ENV).upload(new Blob(['x']))).rejects.toThrow('options.filename')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
