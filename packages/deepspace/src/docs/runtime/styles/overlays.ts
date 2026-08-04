export const DOCS_OVERLAYS_CSS = String.raw`
.docs-modal-layer { position: fixed; z-index: 100; inset: 0; display: flex; background: rgba(9, 11, 17, .48); backdrop-filter: blur(5px); animation: docs-fade-in .14s ease-out; }
.docs-search-layer { align-items: flex-start; justify-content: center; padding: min(12vh, 100px) 16px 16px; }
.docs-search-dialog { width: min(680px, 100%); overflow: hidden; border: 1px solid var(--docs-border-strong); border-radius: 14px; background: var(--docs-surface-raised); box-shadow: var(--docs-shadow-lg); animation: docs-dialog-in .18s ease-out; }
.docs-search-input { display: flex; align-items: center; gap: 11px; height: 56px; padding: 0 15px; border-bottom: 1px solid var(--docs-border); }
.docs-search-input > svg { flex: 0 0 auto; width: 18px; color: var(--docs-muted); }
.docs-search-input input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--docs-text); font-size: 16px; }
.docs-search-input input::placeholder { color: var(--docs-faint); }
.docs-search-input kbd, .docs-search-dialog footer kbd { padding: 2px 5px; border: 1px solid var(--docs-border); border-radius: 5px; background: var(--docs-panel); color: var(--docs-faint); font: 600 9px/1.4 var(--docs-font-mono); }
.docs-search-results { min-height: 180px; max-height: min(56vh, 500px); overflow: auto; padding: 7px; }
.docs-search-empty { display: grid; place-items: center; min-height: 180px; padding: 25px; color: var(--docs-muted); text-align: center; }
.docs-search-empty svg { width: 29px; height: 29px; margin-bottom: 8px; color: var(--docs-accent); }
.docs-search-empty strong { color: var(--docs-text); font-size: 14px; }
.docs-search-empty span { font-size: 12px; }
.docs-search-state { padding: 28px 16px; color: var(--docs-muted); font-size: 13px; text-align: center; }
.docs-search-result, .docs-search-assistant { display: flex; align-items: center; justify-content: space-between; gap: 14px; width: 100%; min-height: 64px; padding: 10px 11px; border: 0; border-radius: 9px; background: transparent; color: var(--docs-text); cursor: pointer; text-align: left; text-decoration: none; }
.docs-search-result.is-active, .docs-search-assistant.is-active { background: var(--docs-panel); }
.docs-search-result > span, .docs-search-assistant > span { min-width: 0; flex: 1; display: grid; }
.docs-search-result strong, .docs-search-assistant strong { overflow: hidden; font-size: 13px; font-weight: 670; text-overflow: ellipsis; white-space: nowrap; }
.docs-search-result small, .docs-search-assistant small { overflow: hidden; color: var(--docs-muted); font-size: 11.5px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
.docs-search-result > svg, .docs-search-assistant > svg:last-child { flex: 0 0 auto; width: 14px; color: var(--docs-faint); }
.docs-search-assistant { border-top: 1px solid var(--docs-border); border-radius: 0 0 9px 9px; color: color-mix(in srgb, var(--docs-accent) 76%, var(--docs-text)); }
.docs-search-assistant > svg:first-child { flex: 0 0 auto; width: 19px; }
.docs-search-result mark { border-radius: 3px; background: color-mix(in srgb, var(--docs-accent) 18%, transparent); color: inherit; }
.docs-search-dialog > footer { display: flex; gap: 17px; padding: 8px 13px; border-top: 1px solid var(--docs-border); background: var(--docs-panel); color: var(--docs-faint); font-size: 9.5px; }
.docs-search-dialog > footer span { display: flex; align-items: center; gap: 3px; }

.docs-mobile-nav { display: flex; flex-direction: column; width: min(342px, 88vw); height: 100%; border-right: 1px solid var(--docs-border); background: var(--docs-bg); box-shadow: var(--docs-shadow-lg); animation: docs-drawer-in .2s ease-out; }
.docs-mobile-nav > header { display: flex; align-items: center; justify-content: space-between; min-height: 64px; border-bottom: 1px solid var(--docs-border); }
.docs-mobile-nav > header .docs-brand { border: 0; padding-left: 20px; }
.docs-mobile-nav > header .docs-icon-button { margin-right: 12px; }
.docs-mobile-nav > .docs-page-tree { padding-top: 22px; }
.docs-mobile-nav > footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 13px; padding: 13px 18px; border-top: 1px solid var(--docs-border); }
.docs-mobile-nav > footer a { color: var(--docs-muted); font-size: 11px; text-decoration: none; }

.docs-assistant-launcher { position: fixed; z-index: 70; left: 50%; bottom: 20px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0; width: min(452px, calc(100vw - 36px)); min-height: 48px; padding: 5px; border: 1px solid color-mix(in srgb, var(--docs-border-strong) 92%, var(--docs-accent)); border-radius: 13px; background: color-mix(in srgb, var(--docs-surface-raised) 96%, transparent); color: var(--docs-text); box-shadow: 0 18px 45px rgba(15, 18, 28, .11), 0 2px 8px rgba(15, 18, 28, .05); transform: translateX(-50%); backdrop-filter: blur(18px) saturate(1.1); transition: border-color .16s, box-shadow .16s, transform .16s; }
.docs-assistant-launcher:hover { border-color: color-mix(in srgb, var(--docs-accent) 32%, var(--docs-border-strong)); box-shadow: 0 20px 48px rgba(15, 18, 28, .14), 0 2px 8px rgba(15, 18, 28, .06); transform: translateX(-50%) translateY(-1px); }
.docs-assistant-launcher input { min-width: 0; height: 36px; padding: 0 12px; border: 0; outline: 0; background: transparent; color: var(--docs-text); font-size: 13px; }
.docs-assistant-launcher input::placeholder { color: var(--docs-muted); }
.docs-launcher-agent, .docs-launcher-send { display: grid; place-items: center; height: 36px; border: 0; border-radius: 9px; cursor: pointer; }
.docs-launcher-agent { width: auto; padding: 0 13px 0 9px; border-right: 1px solid var(--docs-border); border-radius: 0; background: transparent; color: var(--docs-text-soft); font-size: 11.5px; font-weight: 650; white-space: nowrap; }
.docs-launcher-agent:hover { color: var(--docs-accent); }
.docs-launcher-send { width: 36px; padding: 0; }
.docs-launcher-send { background: var(--docs-accent); color: #fff; }
.docs-launcher-send:disabled { background: var(--docs-panel); color: var(--docs-faint); cursor: default; }
.docs-launcher-send svg { width: 15px; }
.docs-assistant { position: fixed; z-index: 90; left: 50%; bottom: 18px; display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; width: min(620px, calc(100vw - 36px)); height: min(570px, calc(100vh - 94px)); overflow: hidden; border: 1px solid var(--docs-border-strong); border-radius: 16px; background: var(--docs-surface); box-shadow: 0 28px 80px rgba(15, 18, 28, .18), 0 6px 22px rgba(15, 18, 28, .08); animation: docs-assistant-in .2s ease-out; transform: translateX(-50%); }
.docs-assistant > header { display: flex; align-items: center; justify-content: space-between; min-height: 54px; padding: 0 11px 0 18px; border-bottom: 1px solid var(--docs-border); }
.docs-assistant > header > div { display: flex; align-items: center; }
.docs-assistant > header > div > span { display: grid; gap: 1px; }
.docs-assistant > header strong { font-size: 13px; font-weight: 620; letter-spacing: -.01em; }
.docs-assistant > header small { color: var(--docs-muted); font-size: 10.5px; }
.docs-assistant > header button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--docs-muted); cursor: pointer; }
.docs-assistant > header button:hover { background: var(--docs-panel); color: var(--docs-text); }
.docs-assistant > header button:focus-visible { outline-width: 1px; outline-offset: 1px; }
.docs-assistant > header button svg { width: 15px; height: 15px; }
.docs-assistant-messages { overflow: auto; padding: 20px 20px 14px; overscroll-behavior: contain; }
.docs-assistant-message { display: flex; align-items: flex-start; margin: 0 0 20px; color: var(--docs-text-soft); font-size: 13px; line-height: 1.64; }
.docs-assistant-message > div { min-width: 0; max-width: 590px; }
.docs-assistant-message.is-user { justify-content: flex-end; margin-left: 54px; }
.docs-assistant-message.is-user > div { padding: 8px 11px; border: 1px solid var(--docs-border); border-radius: 10px; background: var(--docs-panel); color: var(--docs-text); }
.docs-assistant-message.is-error > div { color: #c64b50; }
.docs-assistant-message a { color: color-mix(in srgb, var(--docs-accent) 79%, var(--docs-text)); font-weight: 580; text-underline-offset: 3px; }
.docs-assistant-markdown > :first-child { margin-top: 0; }
.docs-assistant-markdown > :last-child { margin-bottom: 0; }
.docs-assistant-markdown p { margin: 0 0 11px; }
.docs-assistant-markdown ul, .docs-assistant-markdown ol { margin: 0 0 12px; padding-left: 20px; }
.docs-assistant-markdown li { margin: 3px 0; }
.docs-assistant-heading { display: block; margin: 15px 0 6px; color: var(--docs-text); font-family: var(--docs-font-heading); font-size: 13px; }
.docs-assistant-code { overflow: hidden; margin: 12px 0; border: 1px solid var(--docs-border-strong); border-radius: 10px; background: var(--docs-code-bg); color: var(--docs-code-text); }
.docs-assistant-code figcaption { display: flex; align-items: center; justify-content: space-between; min-height: 34px; padding: 0 8px 0 12px; border-bottom: 1px solid rgba(255,255,255,.09); background: var(--docs-code-panel); color: #aeb5c6; font: 600 10.5px/1.3 var(--docs-font-mono); }
.docs-assistant-code button { padding: 4px 7px; border: 1px solid rgba(255,255,255,.1); border-radius: 6px; background: rgba(255,255,255,.06); color: inherit; cursor: pointer; font-size: 10px; }
.docs-assistant-code pre { overflow: auto; margin: 0; padding: 13px; font: 11.5px/1.58 var(--docs-font-mono); }
.docs-assistant-code code { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; white-space: pre; }
.docs-assistant-activity { display: inline-flex; align-items: center; gap: 8px; color: var(--docs-muted); font-size: 12px; }
.docs-assistant-activity > span { width: 6px; height: 6px; border-radius: 50%; background: var(--docs-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--docs-accent) 10%, transparent); animation: docs-activity 1.25s ease-in-out infinite; }
.docs-assistant-suggestions { display: grid; gap: 7px; margin-top: 26px; }
.docs-assistant-suggestions p { margin: 0 0 1px; color: var(--docs-faint); font-size: 10px; font-weight: 650; letter-spacing: .035em; text-transform: uppercase; }
.docs-assistant-suggestions button { min-height: 38px; padding: 8px 11px; border: 1px solid var(--docs-border); border-radius: 9px; background: var(--docs-bg); color: var(--docs-muted); cursor: pointer; font-size: 12px; text-align: left; transition: border-color .14s, background .14s, color .14s; }
.docs-assistant-suggestions button:hover { border-color: var(--docs-border-strong); background: var(--docs-panel); color: var(--docs-text); }
.docs-assistant-composer { display: flex; align-items: flex-end; gap: 7px; margin: 0 16px 9px; padding: 7px; border: 1px solid var(--docs-border-strong); border-radius: 11px; background: var(--docs-bg); box-shadow: 0 3px 12px rgba(15, 18, 28, .045); }
.docs-assistant-composer:focus-within { border-color: color-mix(in srgb, var(--docs-accent) 52%, var(--docs-border)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--docs-accent) 9%, transparent); }
.docs-assistant-composer textarea { min-height: 41px; max-height: 160px; flex: 1; padding: 4px 5px; resize: none; border: 0; outline: 0; background: transparent; color: var(--docs-text); font-size: 12.5px; line-height: 1.5; }
.docs-assistant-composer button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: var(--docs-accent); color: white; cursor: pointer; }
.docs-assistant-composer button:disabled { background: var(--docs-panel-strong); color: var(--docs-faint); cursor: default; }
.docs-assistant > footer { padding: 0 18px 10px; color: var(--docs-faint); font-size: 9.5px; text-align: center; }
@keyframes docs-fade-in { from { opacity: 0; } }
@keyframes docs-dialog-in { from { opacity: 0; transform: translateY(-8px) scale(.99); } }
@keyframes docs-drawer-in { from { transform: translateX(-24px); } }
@keyframes docs-assistant-in { from { transform: translateX(-50%) translateY(18px) scale(.985); opacity: .7; } }
@keyframes docs-page-out { to { opacity: 0; transform: translateY(-3px); } }
@keyframes docs-page-in { from { opacity: 0; transform: translateY(4px); } }
@keyframes docs-activity { 50% { opacity: .42; transform: scale(.82); } }
@keyframes docs-navigation-progress { from { transform: translateX(-20%); } to { transform: translateX(155%); } }

`
