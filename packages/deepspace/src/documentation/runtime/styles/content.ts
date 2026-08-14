export const DOCUMENTATION_CONTENT_CSS = String.raw`
.documentation-main { min-width: 0; margin-left: var(--documentation-sidebar-width); margin-right: 0; transition: margin-right .24s ease; }
.documentation-reader-grid { display: grid; grid-template-columns: minmax(0, 720px) 250px; justify-content: center; gap: 70px; width: 100%; padding: 62px 52px 96px; }
.documentation-reader-column { display: flex; min-width: 0; min-height: calc(100vh - var(--documentation-header-height) - 158px); flex-direction: column; }
.documentation-article { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.documentation-breadcrumbs { display: none; align-items: center; gap: 5px; margin-bottom: 24px; color: var(--documentation-muted); font-size: 13px; }
.documentation-breadcrumbs span { display: inline-flex; align-items: center; gap: 5px; }
.documentation-breadcrumbs svg { width: 12px; height: 12px; }
.documentation-article-header { margin-bottom: 38px; }
.documentation-article-meta { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 32px; margin-bottom: 7px; }
.documentation-eyebrow { color: color-mix(in srgb, var(--documentation-accent) 76%, var(--documentation-text)); font-size: 13px; font-weight: 700; letter-spacing: .035em; }
.documentation-contextual-actions { position: relative; display: inline-flex; flex: 0 0 auto; align-items: stretch; height: 32px; border: 1px solid var(--documentation-border); border-radius: 8px; background: color-mix(in srgb, var(--documentation-surface) 92%, transparent); box-shadow: var(--documentation-shadow-sm); }
.documentation-contextual-actions button, .documentation-contextual-actions a, .documentation-contextual-actions summary { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 30px; padding: 0 10px; border: 0; background: transparent; color: var(--documentation-muted); cursor: pointer; font: 590 12.5px/1 var(--documentation-font-body); text-decoration: none; white-space: nowrap; }
.documentation-contextual-actions button:hover, .documentation-contextual-actions a:hover, .documentation-contextual-actions summary:hover { color: var(--documentation-text); }
.documentation-contextual-actions svg { flex: 0 0 auto; width: 13px; height: 13px; }
.documentation-contextual-actions details { position: relative; border-left: 1px solid var(--documentation-border); }
.documentation-contextual-actions summary { width: 30px; padding: 0; justify-content: center; list-style: none; }
.documentation-contextual-actions summary::-webkit-details-marker { display: none; }
.documentation-contextual-actions details[open] summary { background: var(--documentation-panel); color: var(--documentation-text); }
.documentation-contextual-actions details[open] summary svg { transform: rotate(180deg); }
.documentation-contextual-menu { position: absolute; z-index: 35; top: calc(100% + 7px); right: -1px; display: grid; width: min(344px, calc(100vw - 32px)); max-height: min(510px, calc(100vh - 120px)); overflow: auto; padding: 6px; border: 1px solid var(--documentation-border-strong); border-radius: 12px; background: var(--documentation-surface-raised); box-shadow: var(--documentation-shadow-lg); }
.documentation-contextual-menu button, .documentation-contextual-menu a { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 10px; width: 100%; height: auto; min-height: 52px; padding: 7px 8px; border-radius: 8px; text-align: left; white-space: normal; }
.documentation-contextual-menu button:hover, .documentation-contextual-menu a:hover { background: var(--documentation-panel); }
.documentation-contextual-action-icon { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--documentation-border); border-radius: 7px; background: var(--documentation-surface); color: var(--documentation-text-soft); }
.documentation-contextual-action-icon svg { width: 15px; height: 15px; }
.documentation-contextual-action-copy { display: grid; min-width: 0; gap: 2px; }
.documentation-contextual-action-copy strong { color: var(--documentation-text); font-size: 13px; font-weight: 640; line-height: 1.25; }
.documentation-contextual-action-copy small { color: var(--documentation-muted); font-size: 12px; font-weight: 450; line-height: 1.3; }
.documentation-contextual-menu .documentation-contextual-action-external { width: 12px; height: 12px; color: var(--documentation-faint); }
.documentation-article-header h1 { margin: 0; color: var(--documentation-text); font-family: var(--documentation-font-heading); font-size: clamp(34px, 3vw, 40px); font-weight: 650; letter-spacing: -.025em; line-height: 1.12; overflow-wrap: anywhere; }
.documentation-article-header h1:focus { outline: none; }
.documentation-lede { max-width: 680px; margin: 14px 0 0; color: var(--documentation-text-soft); font-size: 19px; letter-spacing: -.01em; line-height: 1.55; }

.documentation-prose { color: var(--documentation-text-soft); }
.documentation-prose > :first-child { margin-top: 0; }
/* Anchor clearance is owned once, by scroll-padding-top on the html element
 * — a per-heading scroll-margin here stacked with it and landed anchors a
 * full header-height too low. */
.documentation-prose h1, .documentation-prose h2, .documentation-prose h3, .documentation-prose h4, .documentation-prose h5, .documentation-prose h6 { position: relative; color: var(--documentation-text); font-family: var(--documentation-font-heading); }
.documentation-prose h1 { margin: 48px 0 18px; font-size: 30px; letter-spacing: -.025em; line-height: 1.2; }
.documentation-prose h2 { margin: 50px 0 16px; padding-top: 5px; font-size: 25px; font-weight: 625; letter-spacing: -.025em; line-height: 1.28; }
.documentation-prose h3 { margin: 34px 0 12px; font-size: 20px; font-weight: 620; letter-spacing: -.015em; line-height: 1.4; }
.documentation-prose h4 { margin: 28px 0 10px; font-size: 17px; font-weight: 620; }
/* Parked in the gutter so revealing it on hover never reflows the heading. The
 * bare class selector loses to the prose link rule, hence the descendant form. */
.documentation-prose .documentation-heading-anchor { position: absolute; top: 0; left: -.82em; display: flex; align-items: center; height: 100%; padding-right: .25em; color: var(--documentation-faint); font-size: .8em; font-weight: 500; opacity: 0; text-decoration: none; transition: opacity .12s; }
.documentation-prose :is(h1, h2, h3, h4, h5, h6):hover .documentation-heading-anchor, .documentation-prose .documentation-heading-anchor:focus-visible { opacity: 1; }
.documentation-prose p { margin: 0 0 20px; }
.documentation-prose ul, .documentation-prose ol { margin: 0 0 22px; padding-left: 26px; }
.documentation-prose li { margin: 6px 0; padding-left: 3px; }
.documentation-prose li::marker { color: var(--documentation-faint); }
.documentation-prose strong { color: var(--documentation-text); font-weight: 610; }
.documentation-prose a { color: color-mix(in srgb, var(--documentation-accent) 78%, var(--documentation-text)); font-weight: 560; text-decoration-color: color-mix(in srgb, var(--documentation-accent) 38%, transparent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.documentation-prose a:hover { text-decoration-color: currentColor; }
.documentation-prose img { display: block; max-width: 100%; height: auto; margin: 26px 0; border: 1px solid var(--documentation-border); border-radius: 12px; background: var(--documentation-surface); box-shadow: var(--documentation-shadow-sm); }
.documentation-prose blockquote { margin: 25px 0; padding: 4px 0 4px 18px; border-left: 2px solid color-mix(in srgb, var(--documentation-accent) 45%, var(--documentation-border)); color: var(--documentation-muted); }
.documentation-prose blockquote p:last-child { margin-bottom: 0; }
.documentation-prose hr { margin: 44px 0; border: 0; border-top: 1px solid var(--documentation-border); }
.documentation-prose :not(pre) > code, .documentation-assistant-message code { padding: 2px 6px; border-radius: 6px; background: var(--documentation-panel); color: var(--documentation-text); font: 520 .86em/1.4 var(--documentation-font-mono); overflow-wrap: anywhere; }
.documentation-code-block { position: relative; margin: 24px 0; }
.documentation-prose .documentation-code-block pre { margin: 0; }
.documentation-prose pre { position: relative; overflow: auto; margin: 24px 0; padding: 20px; border: 1px solid color-mix(in srgb, var(--documentation-border-strong) 50%, #000); border-radius: 12px; background: linear-gradient(145deg, var(--documentation-code-panel), var(--documentation-code-bg)); color: var(--documentation-code-text); box-shadow: 0 12px 34px rgba(7, 9, 14, .12); font: 14px/1.65 var(--documentation-font-mono); tab-size: 2; }
.documentation-prose pre code { display: block; min-width: max-content; background: transparent; }
/* Actions overlay the code rather than floating inside its text flow, so no line
 * needs padding reserved for them and horizontal scrolling stays exact. */
.documentation-code-actions { position: absolute; z-index: 2; top: 10px; right: 10px; display: inline-flex; gap: 4px; opacity: 0; transition: opacity .14s; }
.documentation-code-block:hover .documentation-code-actions, .documentation-code-actions:focus-within { opacity: 1; }
.documentation-code-actions button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 1px solid rgba(255, 255, 255, .14); border-radius: 7px; background: color-mix(in srgb, var(--documentation-code-panel) 88%, transparent); color: #aeb5c6; cursor: pointer; backdrop-filter: blur(6px); }
.documentation-code-actions button:hover { background: rgba(255, 255, 255, .14); color: #fff; }
.documentation-code-actions svg { width: 15px; height: 15px; }
/* The language rides in the hover actions row as a passive chip instead of a
 * permanently visible label that cost every block 38px of top padding. */
.documentation-code-language { display: inline-flex; align-items: center; height: 30px; padding: 0 9px; border: 1px solid rgba(255, 255, 255, .14); border-radius: 7px; background: color-mix(in srgb, var(--documentation-code-panel) 88%, transparent); color: #7f889c; font: 650 11px/1 var(--documentation-font-mono); letter-spacing: .06em; text-transform: uppercase; pointer-events: none; backdrop-filter: blur(6px); }
/* Fence titles (filenames) get a slim header bar above the code. */
.documentation-code-title { display: flex; align-items: center; min-height: 36px; padding: 0 16px; border: 1px solid color-mix(in srgb, var(--documentation-border-strong) 50%, #000); border-bottom: 0; border-radius: 12px 12px 0 0; background: var(--documentation-code-panel); color: #aeb5c6; font: 600 12px/1.3 var(--documentation-font-mono); }
.documentation-code-block:has(.documentation-code-title) pre { margin-top: 0; border-top-left-radius: 0; border-top-right-radius: 0; }

.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #b7a7ff; }
.hljs-string, .hljs-title, .hljs-name, .hljs-type, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition { color: #73dfb4; }
.hljs-number, .hljs-meta, .hljs-built_in, .hljs-builtin-name, .hljs-params { color: #f0b96b; }
.hljs-comment, .hljs-quote, .hljs-deletion { color: #767f93; font-style: italic; }
.hljs-variable, .hljs-template-variable, .hljs-regexp { color: #ff95b4; }

/* Light code blocks re-tint every token group above; a partial override would
 * leave the dark palette's colors on a near-white background. */
:root[data-code-mode="system"][data-theme="light"] {
  --documentation-code-plain: #252936;
  --documentation-code-keyword: #6f42c1;
  --documentation-code-string: #0a7d55;
  --documentation-code-number: #8a4b00;
  --documentation-code-comment: #636a78;
  --documentation-code-variable: #b3246b;
}
:root[data-code-mode="system"][data-theme="light"] .documentation-prose pre { border-color: var(--documentation-border); background: linear-gradient(145deg, #f7f8fb, #f1f3f7); color: var(--documentation-code-plain); box-shadow: 0 8px 26px rgba(15, 18, 28, .06); }
:root[data-code-mode="system"][data-theme="light"] .documentation-code-actions button { border-color: rgba(17, 19, 26, .12); background: rgba(255, 255, 255, .82); color: #606675; }
:root[data-code-mode="system"][data-theme="light"] .documentation-code-actions button:hover { background: #fff; color: #11131a; }
:root[data-code-mode="system"][data-theme="light"] .documentation-code-language { border-color: rgba(17, 19, 26, .12); background: rgba(255, 255, 255, .82); color: #757c8c; }
:root[data-code-mode="system"][data-theme="light"] .documentation-code-title { border-color: var(--documentation-border); background: #eef1f6; color: #5c6270; }
:root[data-code-mode="system"][data-theme="light"] :is(.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link) { color: var(--documentation-code-keyword); }
:root[data-code-mode="system"][data-theme="light"] :is(.hljs-string, .hljs-title, .hljs-name, .hljs-type, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition) { color: var(--documentation-code-string); }
:root[data-code-mode="system"][data-theme="light"] :is(.hljs-number, .hljs-meta, .hljs-built_in, .hljs-builtin-name, .hljs-params) { color: var(--documentation-code-number); }
:root[data-code-mode="system"][data-theme="light"] :is(.hljs-comment, .hljs-quote, .hljs-deletion) { color: var(--documentation-code-comment); }
:root[data-code-mode="system"][data-theme="light"] :is(.hljs-variable, .hljs-template-variable, .hljs-regexp) { color: var(--documentation-code-variable); }

.documentation-prose table { display: block; width: 100%; overflow: auto; margin: 25px 0 29px; border: 1px solid var(--documentation-border); border-radius: 10px; border-collapse: separate; border-spacing: 0; background: var(--documentation-surface); font-size: 15px; }
.documentation-prose thead { background: var(--documentation-panel); }
.documentation-prose th, .documentation-prose td { min-width: 130px; padding: 11px 14px; border-right: 1px solid var(--documentation-border); border-bottom: 1px solid var(--documentation-border); text-align: left; vertical-align: top; }
.documentation-prose th:last-child, .documentation-prose td:last-child { border-right: 0; }
.documentation-prose tr:last-child td { border-bottom: 0; }
.documentation-prose th { color: var(--documentation-text); font-size: 13px; font-weight: 700; letter-spacing: .02em; }

.documentation-callout { --callout-accent: var(--documentation-accent); position: relative; margin: 24px 0; padding: 16px 18px 16px 20px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--callout-accent) 25%, var(--documentation-border)); border-radius: 11px; background: color-mix(in srgb, var(--callout-accent) 6%, var(--documentation-surface)); }
.documentation-callout::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--callout-accent); }
.documentation-callout > strong { display: block; margin-bottom: 3px; color: color-mix(in srgb, var(--callout-accent) 72%, var(--documentation-text)); font-size: 14px; }
.documentation-callout > :last-child { margin-bottom: 0; }
.documentation-callout-warning { --callout-accent: #c9771a; }
.documentation-callout-tip { --callout-accent: #17a673; }
.documentation-callout-info { --callout-accent: #278fdb; }
.documentation-callout-note { --callout-accent: var(--documentation-accent); }
/* Card bodies are body copy, not links — without this the anchor's link color
 * bleeds into every description. */
.documentation-card { color: var(--documentation-text-soft); display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 12px; margin: 14px 0; padding: 16px 17px; border: 1px solid var(--documentation-border); border-radius: 11px; background: var(--documentation-surface); box-shadow: var(--documentation-shadow-sm); text-decoration: none !important; transition: border-color .16s, box-shadow .16s, transform .16s; }
.documentation-card:hover { border-color: color-mix(in srgb, var(--documentation-accent) 42%, var(--documentation-border)); box-shadow: 0 7px 24px rgba(15, 18, 28, .07); transform: translateY(-1px); }
.documentation-card strong { display: block; margin-bottom: 2px; }
.documentation-accordion-group { margin: 21px 0; border: 1px solid var(--documentation-border); border-radius: 11px; overflow: hidden; }
.documentation-accordion-group .documentation-accordion { margin: 0; border: 0; border-bottom: 1px solid var(--documentation-border); border-radius: 0; }
.documentation-accordion-group .documentation-accordion:last-child { border-bottom: 0; }
.documentation-accordion { margin: 14px 0; padding: 0 16px; border: 1px solid var(--documentation-border); border-radius: 10px; background: var(--documentation-surface); }
.documentation-accordion summary { padding: 14px 25px 14px 0; color: var(--documentation-text); cursor: pointer; font-weight: 650; list-style: none; }
.documentation-accordion summary::-webkit-details-marker { display: none; }
.documentation-accordion summary::after { content: "+"; float: right; margin-right: -20px; color: var(--documentation-faint); font-size: 18px; font-weight: 400; line-height: 1; }
.documentation-accordion[open] summary::after { content: "−"; }
.documentation-accordion > :last-child { margin-bottom: 15px; }
.documentation-steps { margin: 25px 0; counter-reset: documentation-step; }
.documentation-step { position: relative; margin-left: 13px; padding: 0 0 29px 34px; border-left: 1px solid var(--documentation-border-strong); counter-increment: documentation-step; }
.documentation-step:last-child { padding-bottom: 3px; border-color: transparent; }
.documentation-step::before { content: counter(documentation-step); position: absolute; left: -14px; top: -1px; display: grid; place-items: center; width: 27px; height: 27px; border: 1px solid color-mix(in srgb, var(--documentation-accent) 46%, var(--documentation-border)); border-radius: 50%; background: var(--documentation-surface); color: color-mix(in srgb, var(--documentation-accent) 78%, var(--documentation-text)); box-shadow: 0 0 0 5px var(--documentation-bg); font-size: 11px; font-weight: 740; }
.documentation-step h3 { margin-top: 0; }
.documentation-tabs { margin: 23px 0; overflow: hidden; border: 1px solid var(--documentation-border); border-radius: 11px; background: var(--documentation-surface); }
.documentation-tab-buttons { display: flex; gap: 2px; overflow-x: auto; padding: 6px; border-bottom: 1px solid var(--documentation-border); background: var(--documentation-panel); }
.documentation-tab-buttons button { flex: 0 0 auto; padding: 6px 11px; border: 0; border-radius: 7px; background: transparent; color: var(--documentation-muted); cursor: pointer; font-size: 13.5px; font-weight: 620; }
.documentation-tab-buttons button[aria-selected="true"] { background: var(--documentation-surface); color: var(--documentation-text); box-shadow: var(--documentation-shadow-sm); }
.documentation-tab { padding: 16px 18px 2px; }
.documentation-tab > :first-child { margin-top: 0; }
.documentation-code-group { margin: 23px 0; overflow: hidden; border: 1px solid var(--documentation-border-strong); border-radius: 12px; background: var(--documentation-surface); }
.documentation-code-group-title { padding: 8px 13px; border-bottom: 1px solid var(--documentation-border); background: var(--documentation-panel); color: var(--documentation-muted); font-size: 12px; font-weight: 650; }
.documentation-code-group .documentation-tab-buttons { border-color: color-mix(in srgb, var(--documentation-border) 72%, transparent); background: var(--documentation-panel); }
.documentation-code-tab { padding: 0; }
.documentation-code-group .documentation-code-block { margin: 0; }
.documentation-prose .documentation-code-group pre { margin: 0; border: 0; border-radius: 0; box-shadow: none; }

.documentation-api-badge { display: flex; align-items: center; gap: 9px; margin: 0 0 25px; padding: 11px 13px; border: 1px solid var(--documentation-border); border-radius: 10px; background: var(--documentation-panel); }
.method { display: inline-grid; place-items: center; min-width: 52px; padding: 4px 7px; border-radius: 6px; background: #3178e8; color: white; font: 750 10px/1.3 var(--documentation-font-mono); letter-spacing: .035em; }
.method-post { background: #138b5b; }
.method-put, .method-patch { background: #bd7215; }
.method-delete { background: #cd464d; }
.documentation-playground { margin: 48px 0 30px; padding: 20px; border: 1px solid var(--documentation-border); border-radius: 12px; background: var(--documentation-panel); }
.documentation-playground-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.documentation-playground-title > div { display: flex; align-items: center; gap: 9px; }
.documentation-playground-title code { overflow: hidden; color: var(--documentation-muted); font: 11px var(--documentation-font-mono); text-overflow: ellipsis; white-space: nowrap; }
.documentation-playground > p { color: var(--documentation-muted); font-size: 12px; }
.documentation-playground label { display: grid; gap: 5px; margin: 13px 0; color: var(--documentation-muted); font-size: 11px; font-weight: 650; }
.documentation-playground input, .documentation-playground textarea { width: 100%; padding: 10px; border: 1px solid var(--documentation-border-strong); border-radius: 8px; background: var(--documentation-surface); color: var(--documentation-text); font: 12.5px/1.55 var(--documentation-font-mono); resize: vertical; }
.documentation-playground > button { padding: 9px 13px; border: 0; border-radius: 8px; background: var(--documentation-accent); color: var(--documentation-accent-contrast); cursor: pointer; font-size: 12px; font-weight: 680; }
.documentation-playground > button:disabled { opacity: .58; cursor: wait; }
.documentation-playground > pre { max-height: 320px; overflow: auto; margin: 14px 0 0; padding: 13px; border-radius: 8px; background: var(--documentation-code-bg); color: var(--documentation-code-text); font: 11.5px/1.55 var(--documentation-font-mono); white-space: pre-wrap; }

.documentation-context-rail { position: sticky; top: 96px; align-self: start; max-height: calc(100vh - 120px); overflow: auto; padding-left: 18px; }
.documentation-outline { display: grid; gap: 2px; }
.documentation-outline h2 { margin: 0 0 9px; color: var(--documentation-text); font-size: 13.5px; font-weight: 650; }
.documentation-outline a { padding: 5px 0; color: var(--documentation-muted); font-size: 13.5px; line-height: 1.45; text-decoration: none; transition: color .12s; }
.documentation-outline a:hover, .documentation-outline a.is-active { color: var(--documentation-text); }
.documentation-outline a.is-active { color: color-mix(in srgb, var(--documentation-accent) 74%, var(--documentation-text)); font-weight: 640; }
.documentation-outline a.depth-3 { padding-left: 13px; }
/* The outline for viewports that have no room for the sticky rail. */
.documentation-outline-disclosure { display: none; margin: 0 0 32px; border: 1px solid var(--documentation-border); border-radius: 10px; background: var(--documentation-surface); }
.documentation-outline-disclosure > summary { display: flex; align-items: center; gap: 8px; padding: 11px 14px; color: var(--documentation-text); cursor: pointer; font-size: 14px; font-weight: 650; list-style: none; }
.documentation-outline-disclosure > summary::-webkit-details-marker { display: none; }
.documentation-outline-disclosure > summary svg { width: 15px; height: 15px; color: var(--documentation-muted); }
.documentation-outline-disclosure .documentation-outline { padding: 0 14px 12px; }
.documentation-pagination { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; margin-top: auto; padding-top: 28px; }
.documentation-pagination a { display: flex; flex-direction: column; min-height: 86px; padding: 14px 16px; border: 1px solid var(--documentation-border); border-radius: 10px; background: var(--documentation-surface); text-decoration: none; transition: border-color .15s, transform .15s; }
.documentation-pagination a:hover { border-color: color-mix(in srgb, var(--documentation-accent) 38%, var(--documentation-border)); transform: translateY(-1px); }
.documentation-pagination a:last-child { text-align: right; }
.documentation-pagination small { margin-bottom: 7px; color: var(--documentation-faint); font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; }
.documentation-pagination span { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--documentation-text); font-size: 15px; font-weight: 650; }
.documentation-pagination a:last-child span { justify-content: flex-end; }
.documentation-pagination svg { flex: 0 0 auto; width: 15px; }
.documentation-pagination svg.is-back { transform: rotate(180deg); }

`
