import type { DeepSpaceThemeConfig } from './types';

/**
 * CSS color-mix helper — produces `color-mix(in srgb, color pct%, base)`.
 * Works with any valid CSS color format (hex, rgb, rgba, hsl, named).
 */
function mix(color: string, pct: number, base = 'transparent'): string {
  return `color-mix(in srgb, ${color} ${Math.round(pct * 100)}%, ${base})`;
}

/**
 * Determine whether a CSS color is "dark" using relative luminance.
 */
export function isDarkColor(color: string): boolean {
  const c = color.trim();

  // getComputedStyle normalises colors to rgb()/rgba() — handle that first.
  const rgbMatch = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (rgbMatch) {
    const r = parseFloat(rgbMatch[1]) / 255;
    const g = parseFloat(rgbMatch[2]) / 255;
    const b = parseFloat(rgbMatch[3]) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
  }

  // #hex (#rgb / #rrggbb)
  if (!c.startsWith('#')) return true; // unrecognised format — assume dark
  let hex = c.slice(1);
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  if (hex.length !== 6) return true;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/**
 * Static UI tokens for light themes.
 *
 * KEEP IN SYNC with apps/web/app/styles/tokens.css (:root block)
 *
 * Two delivery paths use these same values:
 * - Web app (SSR): defined in tokens.css (instant, no flash)
 * - Deployed sites: applyDeepSpaceTheme() sets them via JS from these constants
 */
const UI_TOKENS_LIGHT: Record<string, string> = {
  '--ui-overlay':        'rgba(0, 0, 0, 0.5)',
  '--ui-bg-primary':     '#ffffff',
  '--ui-bg-secondary':   '#f9fafb',
  '--ui-bg-tertiary':    '#f3f4f6',
  '--ui-bg-elevated':    '#ffffff',
  '--ui-border':         '#e5e7eb',
  '--ui-border-strong':  '#d1d5db',
  '--ui-text-primary':   '#111827',
  '--ui-text-secondary': '#6b7280',
  '--ui-text-muted':     '#9ca3af',
  '--ui-text-disabled':  '#d1d5db',
  '--ui-hover-bg':       '#f3f4f6',
  '--ui-success':        '#10b981',
  '--ui-warning':        '#f59e0b',
  '--ui-error':          '#ef4444',
  '--ui-shadow-sm':      '0 1px 3px rgba(0, 0, 0, 0.1)',
  '--ui-shadow-md':      '0 4px 12px rgba(0, 0, 0, 0.1)',
  '--ui-shadow-lg':      '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
  '--ui-vote-up':        '#f97316',
  '--ui-vote-down':      '#3b82f6',
};

/** Static UI tokens for dark themes — KEEP IN SYNC with [data-ui-theme="dark"] in tokens.css */
const UI_TOKENS_DARK: Record<string, string> = {
  '--ui-overlay':        'rgba(0, 0, 0, 0.7)',
  '--ui-bg-primary':     '#1a1a1b',
  '--ui-bg-secondary':   '#1e1f20',
  '--ui-bg-tertiary':    '#2d2e30',
  '--ui-bg-elevated':    '#1e1f20',
  '--ui-border':         '#3c4043',
  '--ui-border-strong':  '#5a5d61',
  '--ui-text-primary':   '#e8eaed',
  '--ui-text-secondary': '#bdc1c6',
  '--ui-text-muted':     '#9aa0a6',
  '--ui-text-disabled':  '#5a5d61',
  '--ui-hover-bg':       '#3c4043',
  '--ui-success':        '#34d399',
  '--ui-warning':        '#fbbf24',
  '--ui-error':          '#f87171',
  '--ui-shadow-sm':      '0 1px 3px rgba(0, 0, 0, 0.25)',
  '--ui-shadow-md':      '0 4px 12px rgba(0, 0, 0, 0.3)',
  '--ui-shadow-lg':      '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3)',
  '--ui-vote-up':        '#f97316',
  '--ui-vote-down':      '#60a5fa',
};

/** All --ui-* property names for cleanup */
const UI_TOKEN_PROPERTIES = [
  '--ui-overlay', '--ui-bg-primary', '--ui-bg-secondary', '--ui-bg-tertiary', '--ui-bg-elevated',
  '--ui-border', '--ui-border-strong',
  '--ui-text-primary', '--ui-text-secondary', '--ui-text-muted', '--ui-text-disabled',
  '--ui-accent', '--ui-accent-hover', '--ui-accent-secondary',
  '--ui-hover-bg', '--ui-active-bg', '--ui-active-text',
  '--ui-success', '--ui-warning', '--ui-error',
  '--ui-shadow-sm', '--ui-shadow-md', '--ui-shadow-lg',
  '--ui-vote-up', '--ui-vote-down',
] as const;

/**
 * All CSS custom properties set by applyDeepSpaceTheme.
 * Used by clearDeepSpaceTheme to remove stale values on theme switch.
 */
export const DEEPSPACE_THEME_PROPERTIES = [
  // Panel & background
  '--theme-panel-bg', '--theme-panel-bg-opaque', '--theme-panel-bg-secondary',
  '--theme-panel-solid', '--theme-top-panel-bg', '--theme-panel-border',
  '--theme-panel-highlight', '--theme-background',
  // Buttons
  '--theme-button-bg', '--theme-button-border', '--theme-button-hover',
  '--theme-button-border-hover', '--theme-button-active', '--theme-button-fg',
  // Text
  '--theme-text', '--theme-text-hover', '--theme-text-secondary', '--theme-text-tertiary',
  // Accent & colors
  '--theme-accent', '--theme-accent-contrast', '--theme-accent-hover',
  '--theme-secondary', '--theme-secondary-hover', '--theme-primary-hover',
  // Shadows
  '--theme-shadow-primary', '--theme-shadow-secondary', '--theme-shadow-accent',
  '--theme-component-shadow',
  // Surfaces
  '--theme-surface', '--theme-surface-solid',
  '--theme-library-card-bg', '--theme-library-surface', '--theme-library-panel-glass',
  // Borders
  '--theme-border',
  // Status
  '--theme-destructive', '--theme-destructive-hover',
  '--theme-success', '--theme-warning', '--theme-warning-bg', '--theme-warning-fg',
  // Glass
  '--theme-highlight', '--theme-font',
  '--beveled-gradient', '--beveled-glass-shadow',
  // UI component tokens
  ...UI_TOKEN_PROPERTIES,
] as const;

/**
 * Remove all CSS custom properties previously set by applyDeepSpaceTheme.
 * Call before re-applying a new theme to prevent stale variable bleed.
 */
export function clearDeepSpaceTheme(
  root: HTMLElement = document.documentElement,
): void {
  for (const prop of DEEPSPACE_THEME_PROPERTIES) {
    root.style.removeProperty(prop);
  }
}

/**
 * Apply the correct set of --ui-* inline styles for the given UI theme.
 *
 * Single source of truth for --ui-* token application. Called by:
 * - `applyDeepSpaceTheme()` (initial theme setup, canvas theme changes)
 * - `useUITheme` toggle (user switches dark <-> light)
 *
 * When `accent` overrides are provided they are used directly (the
 * `applyDeepSpaceTheme` path). Otherwise the current --theme-accent /
 * --theme-secondary values are read from computed styles.
 */
export function applyUIThemeTokens(
  theme: 'dark' | 'light',
  root: HTMLElement = document.documentElement,
  accent?: { color: string; hover: string; secondary: string },
): void {
  const dark = theme === 'dark';

  // Base tokens (surfaces, text, borders, etc.)
  const base = dark ? UI_TOKENS_DARK : UI_TOKENS_LIGHT;
  for (const [prop, val] of Object.entries(base)) {
    root.style.setProperty(prop, val);
  }

  // Accent-derived tokens
  const accentColor = accent?.color
    ?? (getComputedStyle(root).getPropertyValue('--theme-accent').trim() || (dark ? '#818cf8' : '#3b82f6'));
  const accentHover = accent?.hover
    ?? `color-mix(in srgb, ${accentColor} 90%, black)`;
  const secondary = accent?.secondary
    ?? (getComputedStyle(root).getPropertyValue('--theme-secondary').trim() || accentColor);

  root.style.setProperty('--ui-accent', accentColor);
  root.style.setProperty('--ui-accent-hover', accentHover);
  root.style.setProperty('--ui-accent-secondary', secondary);
  root.style.setProperty('--ui-active-bg', `color-mix(in srgb, ${accentColor} ${dark ? 15 : 10}%, transparent)`);
  root.style.setProperty('--ui-active-text', dark ? secondary : accentColor);
}

/**
 * Apply a DeepSpace theme by setting CSS custom properties on the given root element.
 *
 * Maps a simplified theme config to the full set of --theme-* CSS variables
 * consumed by DeepSpace UI components, pills, and panels.
 *
 * Uses CSS color-mix() for derived colors so any valid CSS color format works
 * (hex, rgb, rgba, hsl, etc.).
 */
export function applyDeepSpaceTheme(
  config: DeepSpaceThemeConfig,
  root: HTMLElement = document.documentElement,
): void {
  const {
    primaryColor,
    panelColor = primaryColor,
    secondaryColor,
    accentColor,
    accentContrastColor = '#ffffff',
    textColor,
    shadowColor = '#000000',
    borderColor = secondaryColor,
    backgroundColor = primaryColor,
    highlightColor = '#ffffff',
    glassmorphism = true,
  } = config;

  // ---------- derived colors ----------

  // Panel backgrounds
  const panelBg = glassmorphism ? mix(panelColor, 0.4) : panelColor;
  const panelBgOpaque = glassmorphism ? mix(panelColor, 0.85) : panelColor;
  const panelSolid = glassmorphism ? mix(panelColor, 0.6, 'white') : panelColor;
  const panelBgSecondary = glassmorphism ? mix(secondaryColor, 0.5) : secondaryColor;
  const topPanelBg = glassmorphism ? mix(panelColor, 0.6) : panelColor;

  // Borders
  const panelBorder = glassmorphism ? mix(borderColor, 0.3) : borderColor;

  // Buttons
  const buttonBg = glassmorphism ? mix(secondaryColor, 0.4) : secondaryColor;
  const buttonBorder = glassmorphism ? mix(borderColor, 0.3) : borderColor;
  const buttonBorderHover = glassmorphism ? mix(borderColor, 0.7) : borderColor;
  const buttonHover = mix(accentColor, 0.2);
  const buttonActive = mix(accentColor, 0.3);

  // Text
  const textSecondary = mix(textColor, 0.8);
  const textTertiary = mix(textColor, 0.6);

  // Accents
  const accentHover = mix(accentColor, 0.9, 'black');
  const secondary = mix(secondaryColor, 0.9);
  const secondaryHover = mix(secondaryColor, 0.9, 'black');
  const primaryHover = mix(primaryColor, 0.9, 'black');

  // Shadows
  const shadowPrimary = mix(shadowColor, 0.1);
  const shadowSecondary = mix(shadowColor, 0.2);
  const shadowAccent = mix(shadowColor, 0.01);
  const componentShadow =
    `0 1px 3px ${mix(shadowColor, 0.12)}, 0 1px 2px ${mix(shadowColor, 0.24)}`;

  // Surfaces & highlights
  const surface = mix(primaryColor, 0.95);
  const panelHighlight = glassmorphism ? mix(textColor, 0.05) : 'transparent';

  // Glass gradients
  const beveledGradient = `linear-gradient(180deg,color-mix(in srgb, ${highlightColor} 40%, transparent) 0%,color-mix(in srgb, ${highlightColor} 15%, transparent) 15%,color-mix(in srgb, ${highlightColor} 5%, transparent) 50%,color-mix(in srgb, ${highlightColor} 8%, transparent) 85%,color-mix(in srgb, ${highlightColor} 25%, transparent) 100%)`;

  // Glass shadows
  const beveledGlassShadow = [
    `inset 0 1px 1px color-mix(in srgb, ${highlightColor} 80%, transparent)`,
    `inset 0 2px 4px color-mix(in srgb, ${highlightColor} 40%, transparent)`,
    `inset 0 -1px 2px rgba(0, 0, 0, 0.08)`,
    `inset 0 -0.5px 0.5px rgba(0, 0, 0, 0.12)`,
    `0 4px 2px -2px rgba(0, 0, 0, 0.12)`,
    `0 8px 16px -4px rgba(0, 0, 0, 0.1)`,
    `0 0 0 0.5px color-mix(in srgb, ${highlightColor} 20%, transparent) inset`,
  ].join(', ');

  // ---------- dark/light detection for UI tokens ----------
  // Respect the user's explicit UI theme preference (set by useUITheme via
  // localStorage) if one exists. Only auto-detect from background luminance
  // when no preference has been set (e.g. deployed sites / mini-apps).
  const preferredUITheme = root.dataset.uiTheme;
  const dark = (preferredUITheme === 'dark' || preferredUITheme === 'light')
    ? preferredUITheme === 'dark'
    : isDarkColor(backgroundColor);

  // ---------- data attributes ----------
  root.dataset.glassmorphism = glassmorphism ? 'enabled' : 'disabled';
  if (!preferredUITheme) {
    root.dataset.uiTheme = dark ? 'dark' : 'light';
  }

  // ---------- batch set CSS properties ----------
  const updates: [string, string][] = [
    // Panel & background
    ['--theme-panel-bg', panelBg],
    ['--theme-panel-bg-opaque', panelBgOpaque],
    ['--theme-panel-bg-secondary', panelBgSecondary],
    ['--theme-panel-solid', panelSolid],
    ['--theme-top-panel-bg', topPanelBg],
    ['--theme-panel-border', panelBorder],
    ['--theme-panel-highlight', panelHighlight],
    ['--theme-background', backgroundColor],

    // Buttons
    ['--theme-button-bg', buttonBg],
    ['--theme-button-border', buttonBorder],
    ['--theme-button-hover', buttonHover],
    ['--theme-button-border-hover', buttonBorderHover],
    ['--theme-button-active', buttonActive],
    ['--theme-button-fg', textColor],

    // Text
    ['--theme-text', textColor],
    ['--theme-text-hover', textColor],
    ['--theme-text-secondary', textSecondary],
    ['--theme-text-tertiary', textTertiary],

    // Accent & colors
    ['--theme-accent', accentColor],
    ['--theme-accent-contrast', accentContrastColor],
    ['--theme-accent-hover', accentHover],
    ['--theme-secondary', secondary],
    ['--theme-secondary-hover', secondaryHover],
    ['--theme-primary-hover', primaryHover],

    // Shadows
    ['--theme-shadow-primary', shadowPrimary],
    ['--theme-shadow-secondary', shadowSecondary],
    ['--theme-shadow-accent', shadowAccent],
    ['--theme-component-shadow', componentShadow],

    // Surfaces
    ['--theme-surface', surface],
    ['--theme-surface-solid', primaryColor],
    ['--theme-library-card-bg', 'rgba(24, 24, 27, 0.95)'],
    ['--theme-library-surface', 'rgba(9, 9, 11, 0.92)'],
    ['--theme-library-panel-glass', 'rgba(24, 24, 27, 0.85)'],

    // Borders
    ['--theme-border', mix(borderColor, 0.8)],

    // Status
    ['--theme-destructive', '#FF3B30'],
    ['--theme-destructive-hover', 'rgba(255, 59, 48, 0.1)'],
    ['--theme-success', '#34C759'],
    ['--theme-warning', '#FF9500'],
    ['--theme-warning-bg', 'rgba(245, 158, 11, 0.15)'],
    ['--theme-warning-fg', '#f59e0b'],

    // Glass highlight
    ['--theme-highlight', highlightColor],

    // Font
    ['--theme-font', "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"],

    // Glass gradients & shadows
    ['--beveled-gradient', beveledGradient],
    ['--beveled-glass-shadow', beveledGlassShadow],
  ];

  for (const [property, value] of updates) {
    root.style.setProperty(property, value);
  }

  // ---------- UI component tokens (modals, profile, library, etc.) ----------
  applyUIThemeTokens(dark ? 'dark' : 'light', root, {
    color: accentColor,
    hover: accentHover,
    secondary,
  });
}

/**
 * Read a DeepSpace theme config from CSS custom properties on the DOM.
 *
 * Reads the widget template's --color-* variables (from the @theme block)
 * and maps them to a DeepSpaceThemeConfig.
 *
 * Falls back to sensible dark-theme defaults if variables are missing.
 */
export function readThemeFromDOM(
  root: HTMLElement = document.documentElement,
): DeepSpaceThemeConfig {
  const styles = getComputedStyle(root);
  const get = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback;

  return {
    primaryColor: get('--color-surface-elevated', '#0f172a'),
    secondaryColor: get('--color-surface-overlay', '#1e293b'),
    accentColor: get('--color-primary', '#818cf8'),
    textColor: get('--color-content', '#f1f5f9'),
    borderColor: get('--color-border', 'rgba(51, 65, 85, 0.5)'),
    backgroundColor: get('--color-surface', '#0a0f1a'),
    highlightColor: '#ffffff',
    shadowColor: '#000000',
    accentContrastColor: '#ffffff',
  };
}
