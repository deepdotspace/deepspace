export const DOCS_BASE_CSS = String.raw`
:root {
  --docs-accent: #635bff;
  --docs-accent-2: #24c8ff;
  --docs-brand-bg: #f8fafc;
  --docs-brand-bg-dark: #0c0e14;
  --docs-font-body: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --docs-font-heading: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --docs-font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --docs-bg: #fbfcfe;
  --docs-surface: #ffffff;
  --docs-surface-raised: #ffffff;
  --docs-panel: #f4f6fa;
  --docs-panel-strong: #edf0f6;
  --docs-text: #11131a;
  --docs-text-soft: #353a47;
  --docs-muted: #5c6270;
  --docs-faint: #646a78;
  --docs-border: #e4e7ed;
  --docs-border-strong: #d7dbe4;
  --docs-code-bg: #11131a;
  --docs-code-panel: #171a23;
  --docs-code-text: #e8ebf5;
  --docs-shadow-sm: 0 1px 2px rgba(15, 18, 28, .04), 0 2px 8px rgba(15, 18, 28, .03);
  --docs-shadow-lg: 0 24px 80px rgba(15, 18, 28, .18), 0 6px 24px rgba(15, 18, 28, .08);
  --docs-header-height: 66px;
  --docs-sidebar-width: 292px;
  color-scheme: light;
  font-family: var(--docs-font-body);
}

:root[data-theme="dark"] {
  --docs-brand-bg: var(--docs-brand-bg-dark);
  --docs-bg: var(--docs-brand-bg-dark);
  --docs-surface: #10131b;
  --docs-surface-raised: #151923;
  --docs-panel: #171b25;
  --docs-panel-strong: #1e2330;
  --docs-text: #f2f4fa;
  --docs-text-soft: #cbd0dc;
  --docs-muted: #999fad;
  --docs-faint: #808797;
  --docs-border: #252a36;
  --docs-border-strong: #343a49;
  --docs-code-bg: #080a0f;
  --docs-code-panel: #10131a;
  --docs-code-text: #eef0f7;
  --docs-shadow-sm: 0 1px 2px rgba(0, 0, 0, .24);
  --docs-shadow-lg: 0 28px 90px rgba(0, 0, 0, .55), 0 8px 24px rgba(0, 0, 0, .35);
  color-scheme: dark;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 92px; }
body { margin: 0; background: var(--docs-brand-bg); color: var(--docs-text); font-family: var(--docs-font-body); font-size: 15.5px; line-height: 1.7; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
:root[data-background-decoration="gradient"] body { background-image: radial-gradient(circle at 58% 7%, color-mix(in srgb, var(--docs-accent) 7%, transparent), transparent 32%); background-attachment: fixed; }
:root[data-background-decoration="grid"] body { background-image: linear-gradient(color-mix(in srgb, var(--docs-border) 26%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--docs-border) 26%, transparent) 1px, transparent 1px); background-attachment: fixed; background-size: 32px 32px; }
body:has(.docs-modal-layer), body:has(.docs-mobile-nav) { overflow: hidden; }
button, input, textarea { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
a { color: inherit; }
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid color-mix(in srgb, var(--docs-accent) 74%, white); outline-offset: 3px; }
::selection { background: color-mix(in srgb, var(--docs-accent) 24%, transparent); }

.docs-skip-link { position: fixed; z-index: 200; top: -64px; left: 16px; padding: 9px 13px; border-radius: 8px; background: var(--docs-text); color: var(--docs-bg); font-weight: 650; text-decoration: none; }
.docs-skip-link:focus { top: 12px; }
.docs-app.is-navigating::before { content: ""; position: fixed; z-index: 240; inset: 0 auto auto 0; width: 42%; height: 2px; background: linear-gradient(90deg, var(--docs-accent), var(--docs-accent-2)); box-shadow: 0 0 14px color-mix(in srgb, var(--docs-accent-2) 48%, transparent); animation: docs-navigation-progress .8s ease-in-out infinite alternate; }
::view-transition-old(docs-article) { animation: docs-page-out .11s ease-in both; }
::view-transition-new(docs-article) { animation: docs-page-in .16s ease-out both; }

`
