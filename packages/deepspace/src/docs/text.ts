/** Render an unknown failure without unsafe structural assumptions. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function escapeXml(value: string): string {
  return escapeHtml(value).replace(/&#39;/g, '&apos;')
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Allocate stable, collision-free ids with the same rules in Markdown and MDX. */
export function createSlugger(fallback = 'section'): (value: string) => string {
  const seen = new Map<string, number>()
  return (value) => {
    const base = slugify(value) || fallback
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count + 1}`
  }
}
