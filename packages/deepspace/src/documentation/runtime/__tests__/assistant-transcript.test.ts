import { describe, expect, it } from 'vitest'
import { completedDocumentationAssistantTranscript } from '../assistant-transcript'

describe('completedDocumentationAssistantTranscript', () => {
  it('keeps only adjacent successful user/assistant pairs', () => {
    expect(
      completedDocumentationAssistantTranscript([
        { role: 'assistant', text: 'Welcome.' },
        { role: 'user', text: 'Successful question' },
        { role: 'assistant', text: 'Successful answer' },
        { role: 'user', text: 'Cancelled question' },
        { role: 'assistant', text: 'Response stopped.', state: 'error' },
        { role: 'user', text: 'Streaming question' },
        { role: 'assistant', text: 'Partial answer', state: 'streaming' },
      ]),
    ).toEqual([
      { role: 'user', content: 'Successful question' },
      { role: 'assistant', content: 'Successful answer' },
    ])
  })

  it('bounds the in-memory transcript by complete pairs', () => {
    const messages = Array.from({ length: 8 }, (_, index) => [
      { role: 'user' as const, text: `question ${index}` },
      { role: 'assistant' as const, text: `answer ${index}` },
    ]).flat()

    expect(completedDocumentationAssistantTranscript(messages, 3)).toEqual([
      { role: 'user', content: 'question 7' },
      { role: 'assistant', content: 'answer 7' },
    ])
    expect(completedDocumentationAssistantTranscript(messages, 1)).toEqual([])
  })
})
