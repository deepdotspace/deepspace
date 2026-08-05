import type { ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { DeepSpaceAgentProfileError, streamDeepSpaceAgent } from '../agent'
import type { DeepSpaceAIEnv } from '../ai'

describe('streamDeepSpaceAgent profile enforcement', () => {
  it('rejects application tools before starting a documentation agent', () => {
    const tools = { records_delete: {} } as unknown as ToolSet
    expect(() =>
      streamDeepSpaceAgent({} as DeepSpaceAIEnv, {
        profile: 'documentation',
        prompt: 'Delete a record',
        tools,
      }),
    ).toThrow(DeepSpaceAgentProfileError)
  })
})
