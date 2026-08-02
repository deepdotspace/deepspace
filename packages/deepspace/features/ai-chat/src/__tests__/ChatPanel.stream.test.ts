import { describe, expect, it } from 'vitest'
import {
  reduceStreamMessages,
  type InFlightMessage,
} from '../ChatPanel.stream'

function assistant(parts: InFlightMessage['parts'] = []): InFlightMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    parts,
    forChatId: 'chat-1',
  }
}

describe('reduceStreamMessages', () => {
  it('coalesces adjacent text while preserving tool chronology', () => {
    const afterText = reduceStreamMessages(
      [assistant()],
      { type: 'append-text', delta: 'Hello' },
      'assistant-1',
    )
    const afterTool = reduceStreamMessages(
      afterText,
      {
        type: 'upsert-tool-call',
        toolCallId: 'tool-1',
        toolName: 'records.query',
        input: { collection: 'tasks' },
      },
      'assistant-1',
    )
    const result = reduceStreamMessages(
      afterTool,
      { type: 'append-text', delta: 'Done' },
      'assistant-1',
    )

    expect(result[0].content).toBe('HelloDone')
    expect(result[0].parts).toEqual([
      { type: 'text', text: 'Hello' },
      {
        type: 'tool-invocation',
        toolCallId: 'tool-1',
        toolInvocation: {
          toolName: 'records.query',
          state: 'call',
          args: { collection: 'tasks' },
        },
      },
      { type: 'text', text: 'Done' },
    ])
  })

  it('upserts duplicate tool calls and finalizes their result', () => {
    const started = reduceStreamMessages(
      [assistant()],
      {
        type: 'upsert-tool-call',
        toolCallId: 'tool-1',
        toolName: 'records.query',
        input: { collection: 'old' },
      },
      'assistant-1',
    )
    const replaced = reduceStreamMessages(
      started,
      {
        type: 'upsert-tool-call',
        toolCallId: 'tool-1',
        toolName: 'records.query',
        input: { collection: 'tasks' },
      },
      'assistant-1',
    )
    const result = reduceStreamMessages(
      replaced,
      {
        type: 'finalize-tool-call',
        toolCallId: 'tool-1',
        result: { records: [] },
      },
      'assistant-1',
    )

    expect(result[0].parts).toHaveLength(1)
    expect(result[0].parts[0]).toMatchObject({
      toolInvocation: {
        state: 'result',
        args: { collection: 'tasks' },
        result: { records: [] },
      },
    })
  })

  it('surfaces input failures as completed failed tool rows', () => {
    const result = reduceStreamMessages(
      [assistant()],
      {
        type: 'fail-tool-input',
        toolCallId: 'tool-1',
        toolName: 'records.update',
        input: { recordId: 42 },
        errorText: 'recordId must be a string',
      },
      'assistant-1',
    )

    expect(result[0].parts[0]).toMatchObject({
      toolInvocation: {
        state: 'result',
        result: { success: false, error: 'recordId must be a string' },
      },
    })
  })

  it('drops an empty stopped assistant but preserves partial output', () => {
    const empty = reduceStreamMessages(
      [assistant()],
      { type: 'abort' },
      'assistant-1',
    )
    const partial = reduceStreamMessages(
      [assistant([{ type: 'text', text: 'Partial' }])],
      { type: 'abort' },
      'assistant-1',
    )

    expect(empty).toEqual([])
    expect(partial).toHaveLength(1)
  })

  it('drops an empty failed assistant without touching other overlays', () => {
    const user: InFlightMessage = {
      id: 'user-1',
      role: 'user',
      content: 'Hello',
      parts: [],
      forChatId: 'chat-1',
    }
    const result = reduceStreamMessages(
      [user, assistant()],
      { type: 'stream-error', errorText: 'rate limited' },
      'assistant-1',
    )

    expect(result).toEqual([user])
  })

  it('preserves partial assistant output when a later stream error arrives', () => {
    const partial = assistant([{ type: 'text', text: 'Partial' }])
    partial.content = 'Partial'

    const result = reduceStreamMessages(
      [partial],
      { type: 'stream-error', errorText: 'connection lost' },
      'assistant-1',
    )

    expect(result).toEqual([partial])
  })
})
