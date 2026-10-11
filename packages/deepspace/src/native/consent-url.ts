/** The consent URL in an integration result, shared by the native and web builds. */

/**
 * The consent URL inside an integration result, or null when none is needed.
 * Reads `data`, falling back to the result itself for a flattened envelope.
 */
export function consentUrlOf(result: { success: boolean; data?: unknown }): string | null {
  if (!result.success) return null
  const payload = (result.data ?? result) as { requiresOAuth?: unknown; authUrl?: unknown } | null
  if (!payload || typeof payload !== 'object') return null
  return payload.requiresOAuth === true && typeof payload.authUrl === 'string'
    ? payload.authUrl
    : null
}
