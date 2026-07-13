/**
 * Theme catalog — the 15 themes this app ships with.
 *
 * To switch the active theme: change `data-theme` on <html> in index.html
 * to one of the ids below. To add a new theme:
 *   1. Append a `[data-theme="my-id"] { ... }` block in src/themes.css
 *      with the shadcn token overrides. If it's a light theme, also
 *      include `color-scheme: light;` inside the block.
 *   2. Add an entry here for type safety, autocomplete, and UI display.
 *   3. Add the theme's background to the first-paint <style> block in
 *      index.html so the pre-CSS frame matches (no white flash).
 *
 * Color values per theme live in src/themes.css — this file is metadata only.
 */

export const THEMES = [
  // ── Dark ─────────────────────────────────────────────────────────────────
  {
    id: 'slate',
    label: 'Slate',
    description: 'Neutral cool gray with indigo accent. The professional default.',
  },
  {
    id: 'ink',
    label: 'Ink',
    description: 'Warm-deep dark with violet accent. Premium design tools.',
  },
  {
    id: 'aurora',
    label: 'Aurora',
    description: 'Deep space cyan on near-black. Futuristic, AI, cyber.',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Deep navy with sky-blue accent. Data, finance, analytics.',
  },
  {
    id: 'forest',
    label: 'Forest',
    description: 'Deep green with sage accent. Calm, focus, reading at night.',
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Near-black warmth with amber accent. Creative coding, cozy nights.',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Pure dark monochrome. Minimalist apps that want to disappear.',
  },
  {
    id: 'noir',
    label: 'Noir',
    description: 'True black with crimson accent. Dramatic, music, video, news.',
  },

  // ── Light ────────────────────────────────────────────────────────────────
  {
    id: 'linen',
    label: 'Linen',
    description: 'Warm off-white with sky-blue accent. Docs, blogs, productivity.',
  },
  {
    id: 'mist',
    label: 'Mist',
    description: 'Cool pale slate. Calm, meditation, wellness.',
  },
  {
    id: 'sand',
    label: 'Sand',
    description: 'Cream with terracotta accent. Lifestyle, journaling, travel.',
  },
  {
    id: 'bloom',
    label: 'Bloom',
    description: 'Pale rose with pink accent. Friendly, social, creative.',
  },
  {
    id: 'paper',
    label: 'Paper',
    description: 'Pure white with near-black accent. Typography, reading, e-readers.',
  },
  {
    id: 'lavender',
    label: 'Lavender',
    description: 'Pale purple with mauve accent. Romantic, fashion, lifestyle.',
  },
  {
    id: 'citrus',
    label: 'Citrus',
    description: 'Light cream with lime accent. Energetic, fitness, youth.',
  },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

/** Read the currently active theme id from <html data-theme>. */
export function getActiveTheme(): ThemeId {
  if (typeof document === 'undefined') return 'slate'
  const id = document.documentElement.getAttribute('data-theme') as ThemeId | null
  return id ?? 'slate'
}

/** Look up a theme entry by id, or fall back to the first theme. */
export function getTheme(id: string) {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}
