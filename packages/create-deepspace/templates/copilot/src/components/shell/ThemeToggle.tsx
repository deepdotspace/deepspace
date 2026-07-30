/**
 * ThemeToggle — a sidebar row (icon + label) that flips between the two
 * shipped themes, `slate` (dark, default) and `paper` (light), by setting
 * `data-theme` on <html> and persisting to localStorage['ui-theme'] — the
 * same key index.html reads pre-paint, so reloads don't flash the default.
 * Shows the mode you'd switch TO: moon while light, sun while dark.
 * `collapsed` fades the label only; the icon column never moves.
 *
 * When the app gets its own themes (see src/themes.ts), point these two
 * constants at the new dark/light ids.
 */

import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import type { ThemeId } from '../../themes'
import { getActiveTheme } from '../../themes'

const DARK_THEME: ThemeId = 'slate'
const LIGHT_THEME: ThemeId = 'paper'
const STORAGE_KEY = 'ui-theme'

function readTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === DARK_THEME || stored === LIGHT_THEME) return stored
  } catch { /* private mode — fall through to the live attribute */ }
  return getActiveTheme()
}

export function ThemeToggle({ collapsed = false }: { collapsed?: boolean }) {
  const [theme, setTheme] = useState<ThemeId>(readTheme)
  const isDark = theme !== LIGHT_THEME

  // Persist ONLY on an explicit click — never on mount. A mount-time write
  // would pin every visitor to whatever theme shipped at the time, silently
  // overriding the app's default when it gets its own theme later.
  const toggle = () => {
    const next = isDark ? LIGHT_THEME : DARK_THEME
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch { /* private mode — state just won't persist */ }
  }

  const label = isDark ? 'Light mode' : 'Dark mode'

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      className="flex w-full items-center gap-[10px] rounded-md px-[10px] py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {isDark ? (
        <Sun className="size-[15px] shrink-0" aria-hidden />
      ) : (
        <Moon className="size-[15px] shrink-0" aria-hidden />
      )}
      <span
        className="whitespace-nowrap transition-opacity duration-150"
        style={{ opacity: collapsed ? 0 : 1 }}
      >
        {label}
      </span>
    </button>
  )
}
