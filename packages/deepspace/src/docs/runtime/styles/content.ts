export const DOCS_CONTENT_CSS = String.raw`
.docs-main { min-width: 0; margin-left: var(--docs-sidebar-width); transition: margin-right .24s ease; }
.docs-reader-grid { display: grid; grid-template-columns: minmax(0, 670px) 212px; justify-content: center; gap: 70px; width: 100%; padding: 62px 52px 156px; }
.docs-article { min-width: 0; view-transition-name: docs-article; }
.docs-breadcrumbs { display: none; align-items: center; gap: 5px; margin-bottom: 24px; color: var(--docs-muted); font-size: 12px; }
.docs-breadcrumbs span { display: inline-flex; align-items: center; gap: 5px; }
.docs-breadcrumbs svg { width: 12px; height: 12px; }
.docs-article-header { margin-bottom: 38px; }
.docs-article-meta { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 32px; margin-bottom: 7px; }
.docs-eyebrow { color: color-mix(in srgb, var(--docs-accent) 76%, var(--docs-text)); font-size: 12px; font-weight: 700; letter-spacing: .035em; }
.docs-contextual-actions { position: relative; display: inline-flex; flex: 0 0 auto; align-items: stretch; height: 30px; border: 1px solid var(--docs-border); border-radius: 8px; background: color-mix(in srgb, var(--docs-surface) 92%, transparent); box-shadow: var(--docs-shadow-sm); }
.docs-contextual-actions button, .docs-contextual-actions a, .docs-contextual-actions summary { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 28px; padding: 0 9px; border: 0; background: transparent; color: var(--docs-muted); cursor: pointer; font: 590 11px/1 var(--docs-font-body); text-decoration: none; white-space: nowrap; }
.docs-contextual-actions button:hover, .docs-contextual-actions a:hover, .docs-contextual-actions summary:hover { color: var(--docs-text); }
.docs-contextual-actions svg { flex: 0 0 auto; width: 13px; height: 13px; }
.docs-contextual-actions details { position: relative; border-left: 1px solid var(--docs-border); }
.docs-contextual-actions summary { width: 29px; padding: 0; justify-content: center; list-style: none; }
.docs-contextual-actions summary::-webkit-details-marker { display: none; }
.docs-contextual-actions details[open] summary { background: var(--docs-panel); color: var(--docs-text); }
.docs-contextual-actions details[open] summary svg { transform: rotate(180deg); }
.docs-contextual-menu { position: absolute; z-index: 35; top: calc(100% + 7px); right: -1px; display: grid; width: min(316px, calc(100vw - 32px)); max-height: min(510px, calc(100vh - 120px)); overflow: auto; padding: 6px; border: 1px solid var(--docs-border-strong); border-radius: 12px; background: var(--docs-surface-raised); box-shadow: var(--docs-shadow-lg); }
.docs-contextual-menu button, .docs-contextual-menu a { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 9px; width: 100%; height: auto; min-height: 50px; padding: 6px 8px; border-radius: 8px; text-align: left; }
.docs-contextual-menu button:hover, .docs-contextual-menu a:hover { background: var(--docs-panel); }
.docs-contextual-action-icon { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--docs-border); border-radius: 7px; background: var(--docs-surface); color: var(--docs-text-soft); }
.docs-contextual-action-icon svg { width: 15px; height: 15px; }
.docs-contextual-action-copy { display: grid; min-width: 0; gap: 2px; }
.docs-contextual-action-copy strong { overflow: hidden; color: var(--docs-text); font-size: 12px; font-weight: 640; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.docs-contextual-action-copy small { overflow: hidden; color: var(--docs-muted); font-size: 10.5px; font-weight: 450; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
.docs-contextual-menu .docs-contextual-action-external { width: 12px; height: 12px; color: var(--docs-faint); }
.docs-article-header h1 { margin: 0; color: var(--docs-text); font-family: var(--docs-font-heading); font-size: clamp(34px, 3vw, 41px); font-weight: 650; letter-spacing: -.038em; line-height: 1.09; overflow-wrap: anywhere; }
.docs-lede { max-width: 650px; margin: 13px 0 0; color: var(--docs-text-soft); font-size: 17.5px; letter-spacing: -.01em; line-height: 1.56; }

.docs-prose { color: var(--docs-text-soft); }
.docs-prose > :first-child { margin-top: 0; }
.docs-prose h1, .docs-prose h2, .docs-prose h3, .docs-prose h4, .docs-prose h5, .docs-prose h6 { color: var(--docs-text); font-family: var(--docs-font-heading); scroll-margin-top: 92px; }
.docs-prose h1 { margin: 46px 0 17px; font-size: 30px; letter-spacing: -.03em; line-height: 1.2; }
.docs-prose h2 { margin: 49px 0 16px; padding-top: 5px; font-size: 25px; font-weight: 625; letter-spacing: -.03em; line-height: 1.25; }
.docs-prose h3 { margin: 33px 0 12px; font-size: 19px; font-weight: 620; letter-spacing: -.018em; line-height: 1.35; }
.docs-prose h4 { margin: 27px 0 10px; font-size: 16px; font-weight: 620; }
.docs-heading-anchor { margin-left: 8px; color: transparent; font-size: .72em; font-weight: 500; text-decoration: none; }
.docs-prose h2:hover .docs-heading-anchor, .docs-prose h3:hover .docs-heading-anchor, .docs-heading-anchor:focus-visible { color: var(--docs-faint); }
.docs-prose p { margin: 0 0 19px; }
.docs-prose ul, .docs-prose ol { margin: 0 0 21px; padding-left: 25px; }
.docs-prose li { margin: 5px 0; padding-left: 3px; }
.docs-prose li::marker { color: var(--docs-faint); }
.docs-prose strong { color: var(--docs-text); font-weight: 610; }
.docs-prose a { color: color-mix(in srgb, var(--docs-accent) 78%, var(--docs-text)); font-weight: 560; text-decoration-color: color-mix(in srgb, var(--docs-accent) 38%, transparent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.docs-prose a:hover { text-decoration-color: currentColor; }
.docs-prose img { display: block; max-width: 100%; height: auto; margin: 26px 0; border: 1px solid var(--docs-border); border-radius: 12px; background: var(--docs-surface); box-shadow: var(--docs-shadow-sm); }
.docs-prose blockquote { margin: 25px 0; padding: 4px 0 4px 18px; border-left: 2px solid color-mix(in srgb, var(--docs-accent) 45%, var(--docs-border)); color: var(--docs-muted); }
.docs-prose blockquote p:last-child { margin-bottom: 0; }
.docs-prose hr { margin: 44px 0; border: 0; border-top: 1px solid var(--docs-border); }
.docs-prose :not(pre) > code, .docs-assistant-message code { padding: 2px 5px; border: 1px solid var(--docs-border); border-radius: 5px; background: var(--docs-panel); color: var(--docs-text); font: 520 .88em/1.4 var(--docs-font-mono); overflow-wrap: anywhere; }
.docs-prose pre { position: relative; overflow: auto; margin: 23px 0; padding: 20px 20px 19px; border: 1px solid color-mix(in srgb, var(--docs-border-strong) 50%, #000); border-radius: 12px; background: linear-gradient(145deg, var(--docs-code-panel), var(--docs-code-bg)); color: var(--docs-code-text); box-shadow: 0 12px 34px rgba(7, 9, 14, .12); font: 13px/1.66 var(--docs-font-mono); tab-size: 2; }
.docs-prose pre code { display: block; min-width: max-content; padding-right: 76px; background: transparent; }
:root[data-code-mode="system"][data-theme="light"] .docs-prose pre { border-color: var(--docs-border); background: linear-gradient(145deg, #f7f8fb, #f1f3f7); color: #252936; box-shadow: 0 8px 26px rgba(15, 18, 28, .06); }
:root[data-code-mode="system"][data-theme="light"] .docs-code-actions button { border-color: rgba(17, 19, 26, .1); background: rgba(255, 255, 255, .72); color: #606675; }
:root[data-code-mode="system"][data-theme="light"] .docs-code-actions button:hover { background: #fff; color: #11131a; }
:root[data-code-mode="system"][data-theme="light"] .hljs-keyword, :root[data-code-mode="system"][data-theme="light"] .hljs-selector-tag, :root[data-code-mode="system"][data-theme="light"] .hljs-literal { color: #6f42c1; }
:root[data-code-mode="system"][data-theme="light"] .hljs-string, :root[data-code-mode="system"][data-theme="light"] .hljs-title, :root[data-code-mode="system"][data-theme="light"] .hljs-name, :root[data-code-mode="system"][data-theme="light"] .hljs-type { color: #087f5b; }
:root[data-code-mode="system"][data-theme="light"] .hljs-number, :root[data-code-mode="system"][data-theme="light"] .hljs-meta, :root[data-code-mode="system"][data-theme="light"] .hljs-built_in { color: #a15c00; }
:root[data-code-mode="system"][data-theme="light"] .hljs-comment, :root[data-code-mode="system"][data-theme="light"] .hljs-quote { color: #7b8190; }
.docs-code-actions { position: sticky; float: right; top: 0; right: 0; display: inline-flex; gap: 4px; margin: -12px -12px 0 10px; }
.docs-code-actions button { height: 28px; padding: 0 8px; border: 1px solid rgba(255, 255, 255, .12); border-radius: 7px; background: rgba(255, 255, 255, .07); color: #aeb5c6; cursor: pointer; font-size: 10.5px; font-weight: 650; }
.docs-code-actions button:hover { background: rgba(255, 255, 255, .12); color: #fff; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #b7a7ff; }
.hljs-string, .hljs-title, .hljs-name, .hljs-type, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition { color: #73dfb4; }
.hljs-number, .hljs-meta, .hljs-built_in, .hljs-builtin-name, .hljs-params { color: #f0b96b; }
.hljs-comment, .hljs-quote, .hljs-deletion { color: #767f93; font-style: italic; }
.hljs-variable, .hljs-template-variable, .hljs-regexp { color: #ff95b4; }

.docs-prose table { display: block; width: 100%; overflow: auto; margin: 25px 0 29px; border: 1px solid var(--docs-border); border-radius: 10px; border-collapse: separate; border-spacing: 0; background: var(--docs-surface); font-size: 14px; }
.docs-prose thead { background: var(--docs-panel); }
.docs-prose th, .docs-prose td { min-width: 130px; padding: 10px 13px; border-right: 1px solid var(--docs-border); border-bottom: 1px solid var(--docs-border); text-align: left; vertical-align: top; }
.docs-prose th:last-child, .docs-prose td:last-child { border-right: 0; }
.docs-prose tr:last-child td { border-bottom: 0; }
.docs-prose th { color: var(--docs-text); font-size: 12px; font-weight: 700; letter-spacing: .02em; }

.docs-callout { --callout-accent: var(--docs-accent); position: relative; margin: 24px 0; padding: 16px 18px 16px 20px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--callout-accent) 25%, var(--docs-border)); border-radius: 11px; background: linear-gradient(105deg, color-mix(in srgb, var(--callout-accent) 7%, var(--docs-surface)), var(--docs-surface)); }
.docs-callout::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--callout-accent); }
.docs-callout > strong { display: block; margin-bottom: 3px; color: color-mix(in srgb, var(--callout-accent) 72%, var(--docs-text)); font-size: 13px; }
.docs-callout > :last-child { margin-bottom: 0; }
.docs-callout-warning { --callout-accent: #e58a21; }
.docs-callout-tip { --callout-accent: #17a673; }
.docs-callout-info { --callout-accent: #278fdb; }
.docs-callout-note { --callout-accent: var(--docs-accent); }
.docs-card { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 12px; margin: 14px 0; padding: 16px 17px; border: 1px solid var(--docs-border); border-radius: 11px; background: var(--docs-surface); box-shadow: var(--docs-shadow-sm); text-decoration: none !important; transition: border-color .16s, box-shadow .16s, transform .16s; }
.docs-card:hover { border-color: color-mix(in srgb, var(--docs-accent) 42%, var(--docs-border)); box-shadow: 0 7px 24px rgba(15, 18, 28, .07); transform: translateY(-1px); }
.docs-card strong { display: block; margin-bottom: 2px; }
.docs-accordion-group { margin: 21px 0; border: 1px solid var(--docs-border); border-radius: 11px; overflow: hidden; }
.docs-accordion-group .docs-accordion { margin: 0; border: 0; border-bottom: 1px solid var(--docs-border); border-radius: 0; }
.docs-accordion-group .docs-accordion:last-child { border-bottom: 0; }
.docs-accordion { margin: 14px 0; padding: 0 16px; border: 1px solid var(--docs-border); border-radius: 10px; background: var(--docs-surface); }
.docs-accordion summary { padding: 14px 25px 14px 0; color: var(--docs-text); cursor: pointer; font-weight: 650; list-style: none; }
.docs-accordion summary::-webkit-details-marker { display: none; }
.docs-accordion summary::after { content: "+"; float: right; margin-right: -20px; color: var(--docs-faint); font-size: 18px; font-weight: 400; line-height: 1; }
.docs-accordion[open] summary::after { content: "−"; }
.docs-accordion > :last-child { margin-bottom: 15px; }
.docs-steps { margin: 25px 0; counter-reset: docs-step; }
.docs-step { position: relative; margin-left: 13px; padding: 0 0 29px 34px; border-left: 1px solid var(--docs-border-strong); counter-increment: docs-step; }
.docs-step:last-child { padding-bottom: 3px; border-color: transparent; }
.docs-step::before { content: counter(docs-step); position: absolute; left: -14px; top: -1px; display: grid; place-items: center; width: 27px; height: 27px; border: 1px solid color-mix(in srgb, var(--docs-accent) 46%, var(--docs-border)); border-radius: 50%; background: var(--docs-surface); color: color-mix(in srgb, var(--docs-accent) 78%, var(--docs-text)); box-shadow: 0 0 0 5px var(--docs-bg); font-size: 11px; font-weight: 740; }
.docs-step h3 { margin-top: 0; }
.docs-tabs { margin: 23px 0; overflow: hidden; border: 1px solid var(--docs-border); border-radius: 11px; background: var(--docs-surface); }
.docs-tab-buttons { display: flex; gap: 2px; overflow-x: auto; padding: 6px; border-bottom: 1px solid var(--docs-border); background: var(--docs-panel); }
.docs-tab-buttons button { flex: 0 0 auto; padding: 6px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--docs-muted); cursor: pointer; font-size: 12.5px; font-weight: 620; }
.docs-tab-buttons button[aria-selected="true"] { background: var(--docs-surface); color: var(--docs-text); box-shadow: var(--docs-shadow-sm); }
.docs-tab { padding: 16px 18px 2px; }
.docs-tab > :first-child { margin-top: 0; }
.docs-code-group { margin: 23px 0; overflow: hidden; border: 1px solid var(--docs-border-strong); border-radius: 12px; background: var(--docs-surface); }
.docs-code-group-title { padding: 8px 13px; border-bottom: 1px solid var(--docs-border); background: var(--docs-panel); color: var(--docs-muted); font-size: 11px; font-weight: 650; }
.docs-code-group .docs-tab-buttons { border-color: color-mix(in srgb, var(--docs-border) 72%, transparent); background: var(--docs-panel); }
.docs-code-tab { padding: 0; }
.docs-code-group pre { margin: 0; border: 0; border-radius: 0; box-shadow: none; }

.docs-api-badge { display: flex; align-items: center; gap: 9px; margin: 0 0 25px; padding: 11px 13px; border: 1px solid var(--docs-border); border-radius: 10px; background: var(--docs-panel); }
.method { display: inline-grid; place-items: center; min-width: 52px; padding: 4px 7px; border-radius: 6px; background: #3178e8; color: white; font: 750 10px/1.3 var(--docs-font-mono); letter-spacing: .035em; }
.method-post { background: #138b5b; }
.method-put, .method-patch { background: #bd7215; }
.method-delete { background: #cd464d; }
.docs-playground { margin: 48px 0 30px; padding: 20px; border: 1px solid var(--docs-border); border-radius: 12px; background: var(--docs-panel); }
.docs-playground-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.docs-playground-title > div { display: flex; align-items: center; gap: 9px; }
.docs-playground-title code { overflow: hidden; color: var(--docs-muted); font: 11px var(--docs-font-mono); text-overflow: ellipsis; white-space: nowrap; }
.docs-playground > p { color: var(--docs-muted); font-size: 12px; }
.docs-playground label { display: grid; gap: 5px; margin: 13px 0; color: var(--docs-muted); font-size: 11px; font-weight: 650; }
.docs-playground input, .docs-playground textarea { width: 100%; padding: 10px; border: 1px solid var(--docs-border-strong); border-radius: 8px; background: var(--docs-surface); color: var(--docs-text); font: 12.5px/1.55 var(--docs-font-mono); resize: vertical; }
.docs-playground > button { padding: 9px 13px; border: 0; border-radius: 8px; background: var(--docs-accent); color: white; cursor: pointer; font-size: 12px; font-weight: 680; }
.docs-playground > button:disabled { opacity: .58; cursor: wait; }
.docs-playground > pre { max-height: 320px; overflow: auto; margin: 14px 0 0; padding: 13px; border-radius: 8px; background: var(--docs-code-bg); color: var(--docs-code-text); font: 11.5px/1.55 var(--docs-font-mono); white-space: pre-wrap; }

.docs-context-rail { position: sticky; top: 92px; align-self: start; max-height: calc(100vh - 116px); overflow: auto; padding-left: 18px; }
.docs-outline { display: grid; gap: 2px; }
.docs-outline h2 { margin: 0 0 7px; color: var(--docs-text); font-size: 11.5px; font-weight: 700; }
.docs-outline a { padding: 3px 0; color: var(--docs-muted); font-size: 11.5px; line-height: 1.42; text-decoration: none; transition: color .12s; }
.docs-outline a:hover, .docs-outline a.is-active { color: var(--docs-text); }
.docs-outline a.is-active { font-weight: 640; }
.docs-outline a.depth-3 { padding-left: 11px; }
.docs-feedback { display: flex; align-items: center; gap: 7px; min-height: 47px; margin-top: 58px; padding: 11px 13px; border: 1px solid var(--docs-border); border-radius: 10px; background: var(--docs-panel); color: var(--docs-muted); font-size: 12px; }
.docs-feedback > span { margin-right: auto; }
.docs-feedback button { padding: 5px 9px; border: 1px solid var(--docs-border); border-radius: 7px; background: var(--docs-surface); color: var(--docs-muted); cursor: pointer; font-size: 11px; }
.docs-feedback button:hover { color: var(--docs-text); }
.docs-feedback p { display: flex; align-items: center; gap: 7px; margin: 0; }
.docs-feedback svg { width: 15px; color: #17a673; }
.docs-pagination { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; margin-top: 28px; }
.docs-pagination a { display: flex; flex-direction: column; min-height: 86px; padding: 14px 15px; border: 1px solid var(--docs-border); border-radius: 10px; background: var(--docs-surface); text-decoration: none; transition: border-color .15s, transform .15s; }
.docs-pagination a:hover { border-color: color-mix(in srgb, var(--docs-accent) 38%, var(--docs-border)); transform: translateY(-1px); }
.docs-pagination a:last-child { text-align: right; }
.docs-pagination small { margin-bottom: 7px; color: var(--docs-faint); font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; }
.docs-pagination span { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--docs-text); font-size: 13px; font-weight: 650; }
.docs-pagination a:last-child span { justify-content: flex-end; }
.docs-pagination svg { flex: 0 0 auto; width: 15px; }
.docs-pagination svg.is-back { transform: rotate(180deg); }

`

