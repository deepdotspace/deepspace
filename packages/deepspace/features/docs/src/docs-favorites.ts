/**
 * Pin favorites — browser localStorage (same pattern as docs2).
 */

const FAVORITES_KEY = 'deepspace-docs-favorites'

export function getFavorites(): Set<string> {
  try {
    const stored = localStorage.getItem(FAVORITES_KEY)
    return stored ? new Set(JSON.parse(stored) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

export function saveFavorites(favs: Set<string>): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favs]))
}
