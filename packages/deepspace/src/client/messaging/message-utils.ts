/**
 * Safely parse a Metadata field that may be a JSON string, an object, or null/undefined.
 * Returns the parsed object or null on failure.
 */
export function parseMessageMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return null }
  }
  return null
}
