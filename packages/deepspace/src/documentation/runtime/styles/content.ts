export const DOCUMENTATION_CONTENT_CSS = String.raw`
.documentation-main { min-width: 0; margin-left: var(--documentation-sidebar-width); transition: margin-right .24s ease; }
.documentation-reader-grid { display: grid; grid-template-columns: minmax(0, 670px) 212px; justify-content: center; gap: 70px; width: 100%; padding: 62px 52px 156px; }
.documentation-article { display: flex; min-width: 0; min-height: calc(100vh - var(--documentation-header-height) - 158px); flex-direction: column; view-transition-name: documentation-article; }
.documentation-breadcrumbs { display: none; align-items: center; gap: 5px; margin-bottom: 24px; color: var(--documentation-muted); font-size: 12px; }
.documentation-breadcrumbs span { display: inline-flex; align-items: center; gap: 5px; }
.documentation-breadcrumbs svg { width: 12px; height: 12px; }
.documentation-article-header { margin-bottom: 38px; }
.documentation-article-meta { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 32px; margin-bottom: 7px; }
.documentation-eyebrow { color: color-mix(in srgb, var(--documentation-accent) 76%, var(--documentation-text)); font-size: 12px; font-weight: 700; letter-spacing: .035em; }
.documentation-contextual-actions { position: relative; display: inline-flex; flex: 0 0 auto; align-items: stretch; height: 30px; border: 1px solid var(--documentation-border); border-radius: 8px; background: color-mix(in srgb, var(--documentation-surface) 92%, transparent); box-shadow: var(--documentation-shadow-sm); }
.documentation-contextual-actions button, .documentation-contextual-actions a, .documentation-contextual-actions summary { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 28px; padding: 0 9px; border: 0; background: transparent; color: var(--documentation-muted); cursor: pointer; font: 590 11px/1 var(--documentation-font-body); text-decoration: none; white-space: nowrap; }
.documentation-contextual-actions button:hover, .documentation-contextual-actions a:hover, .documentation-contextual-actions summary:hover { color: var(--documentation-text); }
.documentation-contextual-actions svg { flex: 0 0 auto; width: 13px; height: 13px; }
.documentation-contextual-actions details { position: relative; border-left: 1px solid var(--documentation-border); }
.documentation-contextual-actions summary { width: 29px; padding: 0; justify-content: center; list-style: none; }
.documentation-contextual-actions summary::-webkit-details-marker { display: none; }
.documentation-contextual-actions details[open] summary { background: var(--documentation-panel); color: var(--documentation-text); }
.documentation-contextual-actions details[open] summary svg { transform: rotate(180deg); }
.documentation-contextual-menu { position: absolute; z-index: 35; top: calc(100% + 7px); right: -1px; display: grid; width: min(316px, calc(100vw - 32px)); max-height: min(510px, calc(100vh - 120px)); overflow: auto; padding: 6px; border: 1px solid var(--documentation-border-strong); border-radius: 12px; background: var(--documentation-surface-raised); box-shadow: var(--documentation-shadow-lg); }
.documentation-contextual-menu button, .documentation-contextual-menu a { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 9px; width: 100%; height: auto; min-height: 50px; padding: 6px 8px; border-radius: 8px; text-align: left; }
.documentation-contextual-menu button:hover, .documentation-contextual-menu a:hover { background: var(--documentation-panel); }
.documentation-contextual-action-icon { display: grid; place-items: center; width: 30px; height: 30px; border: 1px solid var(--documentation-border); border-radius: 7px; background: var(--documentation-surface); color: var(--documentation-text-soft); }
.documentation-contextual-action-icon svg { width: 15px; height: 15px; }
.documentation-contextual-action-copy { display: grid; min-width: 0; gap: 2px; }
.documentation-contextual-action-copy strong { overflow: hidden; color: var(--documentation-text); font-size: 12px; font-weight: 640; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.documentation-contextual-action-copy small { overflow: hidden; color: var(--documentation-muted); font-size: 10.5px; font-weight: 450; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
.documentation-contextual-menu .documentation-contextual-action-external { width: 12px; height: 12px; color: var(--documentation-faint); }
.documentation-article-header h1 { margin: 0; color: var(--documentation-text); font-family: var(--documentation-font-heading); font-size: clamp(34px, 3vw, 41px); font-weight: 650; letter-spacing: -.038em; line-height: 1.09; overflow-wrap: anywhere; }
.documentation-article-header h1:focus { outline: none; }
.documentation-lede { max-width: 650px; margin: 13px 0 0; color: var(--documentation-text-soft); font-size: 17.5px; letter-spacing: -.01em; line-height: 1.56; }

.documentation-prose { color: var(--documentation-text-soft); }
.documentation-prose > :first-child { margin-top: 0; }
.documentation-prose h1, .documentation-prose h2, .documentation-prose h3, .documentation-prose h4, .documentation-prose h5, .documentation-prose h6 { color: var(--documentation-text); font-family: var(--documentation-font-heading); scroll-margin-top: 92px; }
.documentation-prose h1 { margin: 46px 0 17px; font-size: 30px; letter-spacing: -.03em; line-height: 1.2; }
.documentation-prose h2 { margin: 49px 0 16px; padding-top: 5px; font-size: 25px; font-weight: 625; letter-spacing: -.03em; line-height: 1.25; }
.documentation-prose h3 { margin: 33px 0 12px; font-size: 19px; font-weight: 620; letter-spacing: -.018em; line-height: 1.35; }
.documentation-prose h4 { margin: 27px 0 10px; font-size: 16px; font-weight: 620; }
.documentation-heading-anchor { margin-left: 8px; color: transparent; font-size: .72em; font-weight: 500; text-decoration: none; }
.documentation-prose h2:hover .documentation-heading-anchor, .documentation-prose h3:hover .documentation-heading-anchor, .documentation-heading-anchor:focus-visible { color: var(--documentation-faint); }
.documentation-prose p { margin: 0 0 19px; }
.documentation-prose ul, .documentation-prose ol { margin: 0 0 21px; padding-left: 25px; }
.documentation-prose li { margin: 5px 0; padding-left: 3px; }
.documentation-prose li::marker { color: var(--documentation-faint); }
.documentation-prose strong { color: var(--documentation-text); font-weight: 610; }
.documentation-prose a { color: color-mix(in srgb, var(--documentation-accent) 78%, var(--documentation-text)); font-weight: 560; text-decoration-color: color-mix(in srgb, var(--documentation-accent) 38%, transparent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.documentation-prose a:hover { text-decoration-color: currentColor; }
.documentation-prose img { display: block; max-width: 100%; height: auto; margin: 26px 0; border: 1px solid var(--documentation-border); border-radius: 12px; background: var(--documentation-surface); box-shadow: var(--documentation-shadow-sm); }
.documentation-prose blockquote { margin: 25px 0; padding: 4px 0 4px 18px; border-left: 2px solid color-mix(in srgb, var(--documentation-accent) 45%, var(--documentation-border)); color: var(--documentation-muted); }
.documentation-prose blockquote p:last-child { margin-bottom: 0; }
.documentation-prose hr { margin: 44px 0; border: 0; border-top: 1px solid var(--documentation-border); }
.documentation-prose :not(pre) > code, .documentation-assistant-message code { padding: 2px 5px; border: 1px solid var(--documentation-border); border-radius: 5px; background: var(--documentation-panel); color: var(--documentation-text); font: 520 .88em/1.4 var(--documentation-font-mono); overflow-wrap: anywhere; }
.documentation-prose pre { position: relative; overflow: auto; margin: 23px 0; padding: 20px 20px 19px; border: 1px solid color-mix(in srgb, var(--documentation-border-strong) 50%, #000); border-radius: 12px; background: linear-gradient(145deg, var(--documentation-code-panel), var(--documentation-code-bg)); color: var(--documentation-code-text); box-shadow: 0 12px 34px rgba(7, 9, 14, .12); font: 13px/1.66 var(--documentation-font-mono); tab-size: 2; }
.documentation-prose pre code { display: block; min-width: max-content; padding-right: 76px; background: transparent; }
:root[data-code-mode="system"][data-theme="light"] .documentation-prose pre { border-color: var(--documentation-border); background: linear-gradient(145deg, #f7f8fb, #f1f3f7); color: #252936; box-shadow: 0 8px 26px rgba(15, 18, 28, .06); }
:root[data-code-mode="system"][data-theme="light"] .documentation-code-actions button { border-color: rgba(17, 19, 26, .1); background: rgba(255, 255, 255, .72); color: #606675; }
:root[data-code-mode="system"][data-theme="light"] .documentation-code-actions button:hover { background: #fff; color: #11131a; }
:root[data-code-mode="system"][data-theme="light"] .hljs-keyword, :root[data-code-mode="system"][data-theme="light"] .hljs-selector-tag, :root[data-code-mode="system"][data-theme="light"] .hljs-literal { color: #6f42c1; }
:root[data-code-mode="system"][data-theme="light"] .hljs-string, :root[data-code-mode="system"][data-theme="light"] .hljs-title, :root[data-code-mode="system"][data-theme="light"] .hljs-name, :root[data-code-mode="system"][data-theme="light"] .hljs-type { color: #087f5b; }
:root[data-code-mode="system"][data-theme="light"] .hljs-number, :root[data-code-mode="system"][data-theme="light"] .hljs-meta, :root[data-code-mode="system"][data-theme="light"] .hljs-built_in { color: #a15c00; }
:root[data-code-mode="system"][data-theme="light"] .hljs-comment, :root[data-code-mode="system"][data-theme="light"] .hljs-quote { color: #7b8190; }
.documentation-code-actions { position: sticky; float: right; top: 0; right: 0; display: inline-flex; gap: 4px; margin: -12px -12px 0 10px; }
.documentation-code-actions button { height: 28px; padding: 0 8px; border: 1px solid rgba(255, 255, 255, .12); border-radius: 7px; background: rgba(255, 255, 255, .07); color: #aeb5c6; cursor: pointer; font-size: 10.5px; font-weight: 650; }
.documentation-code-actions button:hover { background: rgba(255, 255, 255, .12); color: #fff; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #b7a7ff; }
.hljs-string, .hljs-title, .hljs-name, .hljs-type, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition { color: #73dfb4; }
.hljs-number, .hljs-meta, .hljs-built_in, .hljs-builtin-name, .hljs-params { color: #f0b96b; }
.hljs-comment, .hljs-quote, .hljs-deletion { color: #767f93; font-style: italic; }
.hljs-variable, .hljs-template-variable, .hljs-regexp { color: #ff95b4; }

.documentation-prose table { display: block; width: 100%; overflow: auto; margin: 25px 0 29px; border: 1px solid var(--documentation-border); border-radius: 10px; border-collapse: separate; border-spacing: 0; background: var(--documentation-surface); font-size: 14px; }
.documentation-prose thead { background: var(--documentation-panel); }
.documentation-prose th, .documentation-prose td { min-width: 130px; padding: 10px 13px; border-right: 1px solid var(--documentation-border); border-bottom: 1px solid var(--documentation-border); text-align: left; vertical-align: top; }
.documentation-prose th:last-child, .documentation-prose td:last-child { border-right: 0; }
.documentation-prose tr:last-child td { border-bottom: 0; }
.documentation-prose th { color: var(--documentation-text); font-size: 12px; font-weight: 700; letter-spacing: .02em; }

.documentation-callout { --callout-accent: var(--documentation-accent); position: relative; margin: 24px 0; padding: 16px 18px 16px 20px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--callout-accent) 25%, var(--documentation-border)); border-radius: 11px; background: linear-gradient(105deg, color-mix(in srgb, var(--callout-accent) 7%, var(--documentation-surface)), var(--documentation-surface)); }
.documentation-callout::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 2px; background: var(--callout-accent); }
.documentation-callout > strong { display: block; margin-bottom: 3px; color: color-mix(in srgb, var(--callout-accent) 72%, var(--documentation-text)); font-size: 13px; }
.documentation-callout > :last-child { margin-bottom: 0; }
.documentation-callout-warning { --callout-accent: #e58a21; }
.documentation-callout-tip { --callout-accent: #17a673; }
.documentation-callout-info { --callout-accent: #278fdb; }
.documentation-callout-note { --callout-accent: var(--documentation-accent); }
.documentation-card { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 12px; margin: 14px 0; padding: 16px 17px; border: 1px solid var(--documentation-border); border-radius: 11px; background: var(--documentation-surface); box-shadow: var(--documentation-shadow-sm); text-decoration: none !important; transition: border-color .16s, box-shadow .16s, transform .16s; }
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
.documentation-tab-buttons button { flex: 0 0 auto; padding: 6px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--documentation-muted); cursor: pointer; font-size: 12.5px; font-weight: 620; }
.documentation-tab-buttons button[aria-selected="true"] { background: var(--documentation-surface); color: var(--documentation-text); box-shadow: var(--documentation-shadow-sm); }
.documentation-tab { padding: 16px 18px 2px; }
.documentation-tab > :first-child { margin-top: 0; }
.documentation-code-group { margin: 23px 0; overflow: hidden; border: 1px solid var(--documentation-border-strong); border-radius: 12px; background: var(--documentation-surface); }
.documentation-code-group-title { padding: 8px 13px; border-bottom: 1px solid var(--documentation-border); background: var(--documentation-panel); color: var(--documentation-muted); font-size: 11px; font-weight: 650; }
.documentation-code-group .documentation-tab-buttons { border-color: color-mix(in srgb, var(--documentation-border) 72%, transparent); background: var(--documentation-panel); }
.documentation-code-tab { padding: 0; }
.documentation-code-group pre { margin: 0; border: 0; border-radius: 0; box-shadow: none; }

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
.documentation-playground > button { padding: 9px 13px; border: 0; border-radius: 8px; background: var(--documentation-accent); color: white; cursor: pointer; font-size: 12px; font-weight: 680; }
.documentation-playground > button:disabled { opacity: .58; cursor: wait; }
.documentation-playground > pre { max-height: 320px; overflow: auto; margin: 14px 0 0; padding: 13px; border-radius: 8px; background: var(--documentation-code-bg); color: var(--documentation-code-text); font: 11.5px/1.55 var(--documentation-font-mono); white-space: pre-wrap; }

.documentation-context-rail { position: sticky; top: 92px; align-self: start; max-height: calc(100vh - 116px); overflow: auto; padding-left: 18px; }
.documentation-outline { display: grid; gap: 2px; }
.documentation-outline h2 { margin: 0 0 7px; color: var(--documentation-text); font-size: 11.5px; font-weight: 700; }
.documentation-outline a { padding: 3px 0; color: var(--documentation-muted); font-size: 11.5px; line-height: 1.42; text-decoration: none; transition: color .12s; }
.documentation-outline a:hover, .documentation-outline a.is-active { color: var(--documentation-text); }
.documentation-outline a.is-active { font-weight: 640; }
.documentation-outline a.depth-3 { padding-left: 11px; }
.documentation-feedback { display: flex; align-items: center; gap: 7px; min-height: 47px; margin-top: 58px; padding: 11px 13px; border: 1px solid var(--documentation-border); border-radius: 10px; background: var(--documentation-panel); color: var(--documentation-muted); font-size: 12px; }
.documentation-feedback > span { margin-right: auto; }
.documentation-feedback button { padding: 5px 9px; border: 1px solid var(--documentation-border); border-radius: 7px; background: var(--documentation-surface); color: var(--documentation-muted); cursor: pointer; font-size: 11px; }
.documentation-feedback button:hover { color: var(--documentation-text); }
.documentation-feedback p { display: flex; align-items: center; gap: 7px; margin: 0; }
.documentation-feedback svg { width: 15px; color: #17a673; }
.documentation-pagination { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; margin-top: auto; padding-top: 28px; }
.documentation-app.has-assistant .documentation-pagination { margin-bottom: 76px; transform: translateY(76px); }
.documentation-pagination a { display: flex; flex-direction: column; min-height: 86px; padding: 14px 15px; border: 1px solid var(--documentation-border); border-radius: 10px; background: var(--documentation-surface); text-decoration: none; transition: border-color .15s, transform .15s; }
.documentation-pagination a:hover { border-color: color-mix(in srgb, var(--documentation-accent) 38%, var(--documentation-border)); transform: translateY(-1px); }
.documentation-pagination a:last-child { text-align: right; }
.documentation-pagination small { margin-bottom: 7px; color: var(--documentation-faint); font-size: 10.5px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; }
.documentation-pagination span { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--documentation-text); font-size: 13px; font-weight: 650; }
.documentation-pagination a:last-child span { justify-content: flex-end; }
.documentation-pagination svg { flex: 0 0 auto; width: 15px; }
.documentation-pagination svg.is-back { transform: rotate(180deg); }

`
