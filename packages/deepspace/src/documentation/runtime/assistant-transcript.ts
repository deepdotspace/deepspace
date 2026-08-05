export interface DocumentationAssistantTranscriptMessage {
  role: 'assistant' | 'user'
  text: string
  state?: 'error' | 'streaming'
}

export interface DocumentationAssistantContextMessage {
  role: 'assistant' | 'user'
  content: string
}

/** Select completed in-memory turns to provide as context for the next request. */
export function completedDocumentationAssistantTranscript(
  messages: readonly DocumentationAssistantTranscriptMessage[],
  maxMessages: number = 12,
): DocumentationAssistantContextMessage[] {
  const pairs: Array<
    [DocumentationAssistantContextMessage, DocumentationAssistantContextMessage]
  > = []
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index]
    if (user?.role !== 'user' || user.state !== undefined || !user.text.trim()) continue
    const assistant = messages[index + 1]
    if (
      assistant?.role !== 'assistant' ||
      assistant.state !== undefined ||
      !assistant.text.trim()
    ) {
      continue
    }
    pairs.push([
      { role: 'user', content: user.text },
      { role: 'assistant', content: assistant.text },
    ])
    index += 1
  }

  const pairLimit = Math.max(0, Math.floor(maxMessages / 2))
  if (pairLimit === 0) return []
  return pairs.slice(-pairLimit).flat()
}
