/**
 * Deterministic user color assignment.
 * Same user ID always maps to the same color across sessions.
 */

export const DEFAULT_USER_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#34d399',
  '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6',
  '#e879f9', '#4ade80', '#38bdf8', '#facc15',
] as const

export function getUserColor(userId: string, palette: readonly string[] = DEFAULT_USER_COLORS): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0
  }
  return palette[Math.abs(hash) % palette.length]
}
