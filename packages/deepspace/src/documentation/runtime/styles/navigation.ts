export const DOCUMENTATION_NAVIGATION_CSS = String.raw`
.documentation-header { position: fixed; z-index: 50; inset: 0 0 auto; display: grid; grid-template-columns: var(--documentation-sidebar-width) minmax(300px, 1fr) auto; align-items: center; height: var(--documentation-header-height); border-bottom: 1px solid color-mix(in srgb, var(--documentation-border) 84%, transparent); background: color-mix(in srgb, var(--documentation-bg) 91%, transparent); backdrop-filter: blur(18px) saturate(1.15); transition: right .24s ease; }
.documentation-brand { display: flex; align-items: center; gap: 10px; min-width: 0; height: 100%; padding: 0 23px; color: var(--documentation-text); text-decoration: none; }
.documentation-brand-mark { position: relative; display: grid; place-items: center; width: 27px; height: 27px; color: var(--documentation-accent); }
.documentation-brand-mark::before { content: ""; position: absolute; inset: -7px; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--documentation-accent-2) 15%, transparent), transparent 68%); }
.documentation-brand-mark svg { position: relative; width: 27px; height: 27px; }
.documentation-brand-name { overflow: hidden; font-size: 16px; font-weight: 720; letter-spacing: -.025em; text-overflow: ellipsis; white-space: nowrap; }
.documentation-brand-product { padding-left: 10px; border-left: 1px solid var(--documentation-border-strong); color: var(--documentation-muted); font-size: 13px; font-weight: 600; letter-spacing: .04em; }
.documentation-brand-logo { max-width: 145px; max-height: 26px; object-fit: contain; object-position: left center; }
.documentation-brand-logo-dark { display: none; }
:root[data-theme="dark"] .documentation-brand-logo-light { display: none; }
:root[data-theme="dark"] .documentation-brand-logo-dark { display: block; }

.documentation-header-center { display: flex; align-items: center; justify-content: center; padding: 0 20px; }
.documentation-search-trigger { display: flex; align-items: center; width: min(380px, 38vw); height: 38px; gap: 9px; padding: 0 10px 0 12px; border: 1px solid var(--documentation-border); border-radius: 10px; background: color-mix(in srgb, var(--documentation-surface) 88%, transparent); color: var(--documentation-muted); box-shadow: var(--documentation-shadow-sm); cursor: pointer; text-align: left; transition: border-color .15s, color .15s, transform .15s; }
.documentation-search-trigger:hover { border-color: var(--documentation-border-strong); color: var(--documentation-text); transform: translateY(-1px); }
.documentation-search-trigger > span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.documentation-search-trigger svg { width: 16px; }
.documentation-search-trigger kbd { padding: 2px 6px; border: 1px solid var(--documentation-border); border-radius: 5px; background: var(--documentation-panel); color: var(--documentation-faint); font: 600 12px/1.3 var(--documentation-font-mono); }

.documentation-top-links { display: flex; align-items: center; gap: 18px; height: 100%; padding: 0 24px 0 10px; }
.documentation-top-links a { display: inline-flex; align-items: center; gap: 4px; color: var(--documentation-muted); font-size: 14px; font-weight: 560; text-decoration: none; white-space: nowrap; }
.documentation-top-links a:hover { color: var(--documentation-text); }
.documentation-top-links svg { width: 12px; height: 12px; }
.documentation-mobile-actions { display: none; align-items: center; gap: 3px; padding-right: 12px; }
.documentation-icon-button { display: grid; place-items: center; width: 38px; height: 38px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--documentation-muted); cursor: pointer; }
.documentation-icon-button:hover { background: var(--documentation-panel); color: var(--documentation-text); }

.documentation-frame { min-height: 100vh; padding-top: var(--documentation-header-height); }
.documentation-sidebar { position: fixed; z-index: 30; inset: var(--documentation-header-height) auto 0 0; display: flex; flex-direction: column; width: var(--documentation-sidebar-width); border-right: 1px solid var(--documentation-border); background: var(--documentation-bg); }
.documentation-page-tree { flex: 1; overflow: auto; padding: 26px 18px 36px 22px; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--documentation-border-strong) transparent; }
.documentation-nav-section { margin: 0 0 25px; }
.documentation-nav-section > h2 { margin: 0 0 8px; padding: 0 9px; color: var(--documentation-text); font-size: 14px; font-weight: 650; }
.documentation-nav-link { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 34px; margin: 1px 0; padding: 6px 9px; border-radius: 8px; color: var(--documentation-muted); font-size: 14px; line-height: 1.4; text-decoration: none; transition: background .12s, color .12s; }
.documentation-nav-link > span { min-width: 0; overflow-wrap: anywhere; }
.documentation-nav-link > svg { flex: 0 0 auto; width: 12px; height: 12px; }
.documentation-nav-link:hover { background: var(--documentation-panel); color: var(--documentation-text); }
.documentation-nav-link.is-active { position: relative; background: linear-gradient(90deg, color-mix(in srgb, var(--documentation-accent) 11%, transparent), color-mix(in srgb, var(--documentation-accent-2) 5%, transparent)); color: color-mix(in srgb, var(--documentation-accent) 77%, var(--documentation-text)); font-weight: 650; }
.documentation-nav-link.is-active::before { content: ""; position: absolute; inset: 8px auto 8px -5px; width: 2px; border-radius: 4px; background: linear-gradient(var(--documentation-accent), var(--documentation-accent-2)); box-shadow: 0 0 10px color-mix(in srgb, var(--documentation-accent-2) 52%, transparent); }
.documentation-nav-folder { margin: 2px 0; }
.documentation-nav-folder > summary { display: flex; align-items: center; justify-content: space-between; min-height: 34px; padding: 6px 9px; border-radius: 8px; color: var(--documentation-muted); cursor: pointer; font-size: 14px; font-weight: 620; list-style: none; }
.documentation-nav-folder > summary::-webkit-details-marker { display: none; }
.documentation-nav-folder > summary:hover { background: var(--documentation-panel); color: var(--documentation-text); }
.documentation-nav-folder > summary svg { width: 13px; transition: transform .16s; }
.documentation-nav-folder:not([open]) > summary svg { transform: rotate(-90deg); }
.documentation-nav-folder > div { margin-left: 8px; padding-left: 9px; border-left: 1px solid var(--documentation-border); }

.documentation-sidebar-footer { flex: 0 0 auto; display: grid; gap: 11px; padding: 13px 20px 16px 22px; border-top: 1px solid var(--documentation-border); background: color-mix(in srgb, var(--documentation-panel) 46%, var(--documentation-bg)); }
.documentation-sidebar-footer > nav { display: flex; flex-wrap: wrap; gap: 8px 13px; }
.documentation-sidebar-footer a, .documentation-sidebar-footer > span { color: var(--documentation-faint); font-size: 12px; text-decoration: none; }
.documentation-sidebar-footer a:hover { color: var(--documentation-text); }
.documentation-theme-controls { display: inline-flex; width: max-content; padding: 2px; border: 1px solid var(--documentation-border); border-radius: 9px; background: var(--documentation-surface); box-shadow: var(--documentation-shadow-sm); }
.documentation-theme-controls button { display: grid; place-items: center; width: 28px; height: 25px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--documentation-faint); cursor: pointer; }
.documentation-theme-controls button:hover { color: var(--documentation-text); }
.documentation-theme-controls button[aria-pressed="true"] { background: var(--documentation-panel-strong); color: var(--documentation-text); }
.documentation-theme-controls svg { width: 14px; height: 14px; }

`
