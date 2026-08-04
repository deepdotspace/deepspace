export const DOCS_NAVIGATION_CSS = String.raw`
.docs-header { position: fixed; z-index: 50; inset: 0 0 auto; display: grid; grid-template-columns: var(--docs-sidebar-width) minmax(300px, 1fr) auto; align-items: center; height: var(--docs-header-height); border-bottom: 1px solid color-mix(in srgb, var(--docs-border) 84%, transparent); background: color-mix(in srgb, var(--docs-bg) 91%, transparent); backdrop-filter: blur(18px) saturate(1.15); transition: right .24s ease; }
.docs-brand { display: flex; align-items: center; gap: 10px; min-width: 0; height: 100%; padding: 0 23px; color: var(--docs-text); text-decoration: none; }
.docs-brand-mark { position: relative; display: grid; place-items: center; width: 27px; height: 27px; color: var(--docs-accent); }
.docs-brand-mark::before { content: ""; position: absolute; inset: -7px; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--docs-accent-2) 15%, transparent), transparent 68%); }
.docs-brand-mark svg { position: relative; width: 27px; height: 27px; }
.docs-brand-name { overflow: hidden; font-size: 16px; font-weight: 720; letter-spacing: -.025em; text-overflow: ellipsis; white-space: nowrap; }
.docs-brand-product { padding-left: 10px; border-left: 1px solid var(--docs-border-strong); color: var(--docs-muted); font-size: 12px; font-weight: 600; letter-spacing: .04em; }
.docs-brand-logo { max-width: 145px; max-height: 26px; object-fit: contain; object-position: left center; }
.docs-brand-logo-dark { display: none; }
:root[data-theme="dark"] .docs-brand-logo-light { display: none; }
:root[data-theme="dark"] .docs-brand-logo-dark { display: block; }

.docs-header-center { display: flex; align-items: center; justify-content: center; padding: 0 20px; }
.docs-search-trigger { display: flex; align-items: center; width: min(380px, 38vw); height: 38px; gap: 9px; padding: 0 10px 0 12px; border: 1px solid var(--docs-border); border-radius: 10px; background: color-mix(in srgb, var(--docs-surface) 88%, transparent); color: var(--docs-muted); box-shadow: var(--docs-shadow-sm); cursor: pointer; text-align: left; transition: border-color .15s, color .15s, transform .15s; }
.docs-search-trigger:hover { border-color: var(--docs-border-strong); color: var(--docs-text); transform: translateY(-1px); }
.docs-search-trigger > span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.docs-search-trigger svg { width: 16px; }
.docs-search-trigger kbd { padding: 2px 5px; border: 1px solid var(--docs-border); border-radius: 5px; background: var(--docs-panel); color: var(--docs-faint); font: 600 10px/1.3 var(--docs-font-mono); }

.docs-top-links { display: flex; align-items: center; gap: 18px; height: 100%; padding: 0 24px 0 10px; }
.docs-top-links a { display: inline-flex; align-items: center; gap: 4px; color: var(--docs-muted); font-size: 13px; font-weight: 560; text-decoration: none; white-space: nowrap; }
.docs-top-links a:hover { color: var(--docs-text); }
.docs-top-links svg { width: 12px; height: 12px; }
.docs-mobile-actions { display: none; align-items: center; gap: 3px; padding-right: 12px; }
.docs-icon-button { display: grid; place-items: center; width: 38px; height: 38px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--docs-muted); cursor: pointer; }
.docs-icon-button:hover { background: var(--docs-panel); color: var(--docs-text); }

.docs-frame { min-height: 100vh; padding-top: var(--docs-header-height); }
.docs-sidebar { position: fixed; z-index: 30; inset: var(--docs-header-height) auto 0 0; display: flex; flex-direction: column; width: var(--docs-sidebar-width); border-right: 1px solid var(--docs-border); background: var(--docs-bg); }
.docs-page-tree { flex: 1; overflow: auto; padding: 26px 18px 36px 22px; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--docs-border-strong) transparent; }
.docs-nav-section { margin: 0 0 25px; }
.docs-nav-section > h2 { margin: 0 0 7px; padding: 0 9px; color: var(--docs-text-soft); font-size: 11.5px; font-weight: 720; letter-spacing: .025em; }
.docs-nav-link { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 33px; margin: 1px 0; padding: 6px 9px; border-radius: 8px; color: var(--docs-muted); font-size: 13.25px; line-height: 1.38; text-decoration: none; transition: background .12s, color .12s; }
.docs-nav-link > span { min-width: 0; overflow-wrap: anywhere; }
.docs-nav-link > svg { flex: 0 0 auto; width: 12px; height: 12px; }
.docs-nav-link:hover { background: var(--docs-panel); color: var(--docs-text); }
.docs-nav-link.is-active { position: relative; background: linear-gradient(90deg, color-mix(in srgb, var(--docs-accent) 11%, transparent), color-mix(in srgb, var(--docs-accent-2) 5%, transparent)); color: color-mix(in srgb, var(--docs-accent) 77%, var(--docs-text)); font-weight: 650; }
.docs-nav-link.is-active::before { content: ""; position: absolute; inset: 8px auto 8px -5px; width: 2px; border-radius: 4px; background: linear-gradient(var(--docs-accent), var(--docs-accent-2)); box-shadow: 0 0 10px color-mix(in srgb, var(--docs-accent-2) 52%, transparent); }
.docs-nav-folder { margin: 2px 0; }
.docs-nav-folder > summary { display: flex; align-items: center; justify-content: space-between; min-height: 34px; padding: 6px 9px; border-radius: 8px; color: var(--docs-muted); cursor: pointer; font-size: 13.25px; font-weight: 620; list-style: none; }
.docs-nav-folder > summary::-webkit-details-marker { display: none; }
.docs-nav-folder > summary:hover { background: var(--docs-panel); color: var(--docs-text); }
.docs-nav-folder > summary svg { width: 13px; transition: transform .16s; }
.docs-nav-folder:not([open]) > summary svg { transform: rotate(-90deg); }
.docs-nav-folder > div { margin-left: 8px; padding-left: 9px; border-left: 1px solid var(--docs-border); }

.docs-sidebar-footer { flex: 0 0 auto; display: grid; gap: 11px; padding: 13px 20px 16px 22px; border-top: 1px solid var(--docs-border); background: color-mix(in srgb, var(--docs-panel) 46%, var(--docs-bg)); }
.docs-sidebar-footer > nav { display: flex; flex-wrap: wrap; gap: 8px 13px; }
.docs-sidebar-footer a, .docs-sidebar-footer > span { color: var(--docs-faint); font-size: 10.5px; text-decoration: none; }
.docs-sidebar-footer a:hover { color: var(--docs-text); }
.docs-theme-controls { display: inline-flex; width: max-content; padding: 2px; border: 1px solid var(--docs-border); border-radius: 9px; background: var(--docs-surface); box-shadow: var(--docs-shadow-sm); }
.docs-theme-controls button { display: grid; place-items: center; width: 28px; height: 25px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--docs-faint); cursor: pointer; }
.docs-theme-controls button:hover { color: var(--docs-text); }
.docs-theme-controls button[aria-pressed="true"] { background: var(--docs-panel-strong); color: var(--docs-text); }
.docs-theme-controls svg { width: 14px; height: 14px; }

`

