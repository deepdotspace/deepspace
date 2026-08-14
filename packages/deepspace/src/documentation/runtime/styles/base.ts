export const DOCUMENTATION_BASE_CSS = String.raw`
:root {
  /* The configured accent is injected as --documentation-accent-light; the
   * dark theme swaps in --documentation-accent-dark, which defaults to a
   * readable lightened derivative so a site that configures only one accent
   * never ships invisible links on the dark background. */
  --documentation-accent-light: #635bff;
  --documentation-accent-dark: color-mix(in oklab, var(--documentation-accent-light) 52%, white);
  --documentation-accent: var(--documentation-accent-light);
  /* Glyphs painted directly on the accent. Dark lightens the accent, so the
   * readable ink on it flips from white to near-black. */
  --documentation-accent-contrast: #ffffff;
  --documentation-brand-bg: #f8fafc;
  --documentation-brand-bg-dark: #0c0e14;
  --documentation-font-body: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --documentation-font-heading: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --documentation-font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --documentation-bg: #fbfcfe;
  --documentation-surface: #ffffff;
  --documentation-surface-raised: #ffffff;
  --documentation-panel: #f4f6fa;
  --documentation-panel-strong: #edf0f6;
  --documentation-text: #11131a;
  --documentation-text-soft: #353a47;
  --documentation-muted: #5c6270;
  --documentation-faint: #646a78;
  --documentation-border: #e4e7ed;
  --documentation-border-strong: #d7dbe4;
  --documentation-code-bg: #11131a;
  --documentation-code-panel: #171a23;
  --documentation-code-text: #e8ebf5;
  --documentation-shadow-sm: 0 1px 2px rgba(15, 18, 28, .04), 0 2px 8px rgba(15, 18, 28, .03);
  --documentation-shadow-lg: 0 24px 80px rgba(15, 18, 28, .18), 0 6px 24px rgba(15, 18, 28, .08);
  /* Honest glass: used only where content physically passes beneath a surface
   * (the launcher pill, the floating/mobile assistant panel). High-opacity
   * tint plus blur keeps the surface legible over prose, dark code, and
   * images without any protective gradient; the inset highlight is the lit
   * top edge that makes the pane read as material rather than mist. */
  --documentation-glass-bg: color-mix(in srgb, var(--documentation-surface-raised) 86%, transparent);
  --documentation-glass-border: color-mix(in srgb, var(--documentation-border-strong) 90%, var(--documentation-accent));
  --documentation-glass-highlight: rgba(255, 255, 255, .6);
  --documentation-header-height: 66px;
  --documentation-sidebar-width: 292px;
  --documentation-assistant-width: 420px;
  /* Darkened against the light page; the dark theme lightens it instead. */
  --documentation-focus-ring: color-mix(in srgb, var(--documentation-accent) 82%, var(--documentation-text));
  color-scheme: light;
  font-family: var(--documentation-font-body);
}

:root[data-theme="dark"] {
  --documentation-accent: var(--documentation-accent-dark);
  --documentation-accent-contrast: #0c0e14;
  --documentation-brand-bg: var(--documentation-brand-bg-dark);
  --documentation-bg: var(--documentation-brand-bg-dark);
  --documentation-surface: #10131b;
  --documentation-surface-raised: #151923;
  --documentation-panel: #171b25;
  --documentation-panel-strong: #1e2330;
  --documentation-text: #f2f4fa;
  --documentation-text-soft: #cbd0dc;
  --documentation-muted: #999fad;
  --documentation-faint: #808797;
  --documentation-border: #252a36;
  --documentation-border-strong: #343a49;
  --documentation-code-bg: #080a0f;
  --documentation-code-panel: #10131a;
  --documentation-code-text: #eef0f7;
  --documentation-shadow-sm: 0 1px 2px rgba(0, 0, 0, .24);
  --documentation-shadow-lg: 0 28px 90px rgba(0, 0, 0, .55), 0 8px 24px rgba(0, 0, 0, .35);
  --documentation-glass-bg: color-mix(in srgb, var(--documentation-surface-raised) 80%, transparent);
  --documentation-glass-border: color-mix(in srgb, var(--documentation-border-strong) 86%, var(--documentation-accent));
  --documentation-glass-highlight: rgba(255, 255, 255, .07);
  --documentation-focus-ring: color-mix(in srgb, var(--documentation-accent) 74%, white);
  color-scheme: dark;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 96px; scrollbar-gutter: stable; }
body { margin: 0; background: var(--documentation-brand-bg); color: var(--documentation-text); font-family: var(--documentation-font-body); font-size: 17px; line-height: 1.65; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
:root[data-background-decoration="gradient"] body { background-image: radial-gradient(circle at 58% 7%, color-mix(in srgb, var(--documentation-accent) 7%, transparent), transparent 32%); background-attachment: fixed; }
:root[data-background-decoration="grid"] body { background-image: linear-gradient(color-mix(in srgb, var(--documentation-border) 26%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--documentation-border) 26%, transparent) 1px, transparent 1px); background-attachment: fixed; background-size: 32px 32px; }
body:has(.documentation-modal-layer), body:has(.documentation-mobile-nav) { overflow: hidden; }
button, input, textarea { font: inherit; }
button, a, summary, label { -webkit-tap-highlight-color: transparent; }
a { color: inherit; }
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--documentation-focus-ring); outline-offset: 3px; }
::selection { background: color-mix(in srgb, var(--documentation-accent) 24%, transparent); }
/* Chrome is an instrument, not a document: its labels never select and its
 * links never spawn the native drag ghost. The article prose, assistant
 * answers, and every input stay fully selectable. (The router's dragstart
 * chokepoint enforces the no-ghost rule in engines without -webkit-user-drag.) */
.documentation-header, .documentation-sidebar, .documentation-mobile-nav, .documentation-outline, .documentation-outline-disclosure > summary, .documentation-breadcrumbs, .documentation-article-meta, .documentation-pagination, .documentation-search-dialog, .documentation-launcher-dock, .documentation-assistant > header, .documentation-assistant-suggestions, .documentation-assistant > footer, .documentation-tab-buttons, .documentation-code-actions, .documentation-theme-controls { user-select: none; -webkit-user-select: none; }
.documentation-search-dialog input, .documentation-launcher-dock input, .documentation-search-results { user-select: text; -webkit-user-select: text; }
:is(.documentation-header, .documentation-sidebar, .documentation-mobile-nav, .documentation-outline, .documentation-breadcrumbs, .documentation-article-meta, .documentation-pagination, .documentation-search-dialog) :is(a, img) { -webkit-user-drag: none; }

.documentation-skip-link { position: fixed; z-index: 200; top: -64px; left: 16px; padding: 9px 13px; border-radius: 8px; background: var(--documentation-text); color: var(--documentation-bg); font-weight: 650; text-decoration: none; }
.documentation-skip-link:focus { top: 12px; }
/* The only navigation feedback. The article itself never animates: a route
 * swap is a hard cut committed in one frame, because any overlap of two text
 * layers — any fade, slide, or view transition — reads as ghosting. */
.documentation-app.is-navigating::before { content: ""; position: fixed; z-index: 240; inset: 0 auto auto 0; width: 42%; height: 2px; background: var(--documentation-accent); animation: documentation-navigation-progress .8s ease-in-out infinite alternate; }

`
