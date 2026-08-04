export interface DocsAssistantTranscriptMessage {
  role: 'assistant' | 'user'
  text: string
  state?: 'error' | 'streaming'
}

export interface DocsAssistantHistoryMessage {
  role: 'assistant' | 'user'
  content: string
}

/**
 * Build a server transcript from adjacent, successful user/assistant pairs.
 * A cancelled or failed answer invalidates its question as context too; keeping
 * only the user half would produce a non-alternating transcript on the next
 * request and permanently wedge the stateless assistant until page reload.
 */
export function completedDocsAssistantHistory(
  messages: readonly DocsAssistantTranscriptMessage[],
  maxMessages: number = 12,
): DocsAssistantHistoryMessage[] {
  const pairs: Array<[DocsAssistantHistoryMessage, DocsAssistantHistoryMessage]> = []
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
