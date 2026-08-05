export const DOCUMENTATION_OVERLAYS_CSS = String.raw`
.documentation-modal-layer { position: fixed; z-index: 100; inset: 0; display: flex; background: rgba(9, 11, 17, .48); backdrop-filter: blur(5px); animation: documentation-fade-in .14s ease-out; }
.documentation-search-layer { align-items: flex-start; justify-content: center; padding: min(12vh, 100px) 16px 16px; }
.documentation-search-dialog { width: min(680px, 100%); overflow: hidden; border: 1px solid var(--documentation-border-strong); border-radius: 14px; background: var(--documentation-surface-raised); box-shadow: var(--documentation-shadow-lg); animation: documentation-dialog-in .18s ease-out; }
.documentation-search-input { display: flex; align-items: center; gap: 11px; height: 56px; padding: 0 15px; border-bottom: 1px solid var(--documentation-border); }
.documentation-search-input > svg { flex: 0 0 auto; width: 18px; color: var(--documentation-muted); }
.documentation-search-input input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--documentation-text); font-size: 16px; }
.documentation-search-input input::placeholder { color: var(--documentation-faint); }
.documentation-search-input kbd, .documentation-search-dialog footer kbd { padding: 2px 5px; border: 1px solid var(--documentation-border); border-radius: 5px; background: var(--documentation-panel); color: var(--documentation-faint); font: 600 9px/1.4 var(--documentation-font-mono); }
.documentation-search-results { min-height: 180px; max-height: min(56vh, 500px); overflow: auto; padding: 7px; }
.documentation-search-empty { display: grid; place-items: center; min-height: 180px; padding: 25px; color: var(--documentation-muted); text-align: center; }
.documentation-search-empty svg { width: 29px; height: 29px; margin-bottom: 8px; color: var(--documentation-accent); }
.documentation-search-empty strong { color: var(--documentation-text); font-size: 14px; }
.documentation-search-empty span { font-size: 12px; }
.documentation-search-state { padding: 28px 16px; color: var(--documentation-muted); font-size: 13px; text-align: center; }
.documentation-search-result, .documentation-search-assistant { display: flex; align-items: center; justify-content: space-between; gap: 14px; width: 100%; min-height: 64px; padding: 10px 11px; border: 0; border-radius: 9px; background: transparent; color: var(--documentation-text); cursor: pointer; text-align: left; text-decoration: none; }
.documentation-search-result.is-active, .documentation-search-assistant.is-active { background: var(--documentation-panel); }
.documentation-search-result > span, .documentation-search-assistant > span { min-width: 0; flex: 1; display: grid; }
.documentation-search-result strong, .documentation-search-assistant strong { overflow: hidden; font-size: 13px; font-weight: 670; text-overflow: ellipsis; white-space: nowrap; }
.documentation-search-result small, .documentation-search-assistant small { overflow: hidden; color: var(--documentation-muted); font-size: 11.5px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
.documentation-search-result > svg, .documentation-search-assistant > svg:last-child { flex: 0 0 auto; width: 14px; color: var(--documentation-faint); }
.documentation-search-assistant { border-top: 1px solid var(--documentation-border); border-radius: 0 0 9px 9px; color: color-mix(in srgb, var(--documentation-accent) 76%, var(--documentation-text)); }
.documentation-search-assistant > svg:first-child { flex: 0 0 auto; width: 19px; }
.documentation-search-result mark { border-radius: 3px; background: color-mix(in srgb, var(--documentation-accent) 18%, transparent); color: inherit; }
.documentation-search-dialog > footer { display: flex; gap: 17px; padding: 8px 13px; border-top: 1px solid var(--documentation-border); background: var(--documentation-panel); color: var(--documentation-faint); font-size: 9.5px; }
.documentation-search-dialog > footer span { display: flex; align-items: center; gap: 3px; }

.documentation-mobile-nav { display: flex; flex-direction: column; width: min(342px, 88vw); height: 100%; border-right: 1px solid var(--documentation-border); background: var(--documentation-bg); box-shadow: var(--documentation-shadow-lg); animation: documentation-drawer-in .2s ease-out; }
.documentation-mobile-nav > header { display: flex; align-items: center; justify-content: space-between; min-height: 64px; border-bottom: 1px solid var(--documentation-border); }
.documentation-mobile-nav > header .documentation-brand { border: 0; padding-left: 20px; }
.documentation-mobile-nav > header .documentation-icon-button { margin-right: 12px; }
.documentation-mobile-nav > .documentation-page-tree { padding-top: 22px; }
.documentation-mobile-nav > footer { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 13px; padding: 13px 18px; border-top: 1px solid var(--documentation-border); }
.documentation-mobile-nav > footer a { color: var(--documentation-muted); font-size: 11px; text-decoration: none; }

.documentation-assistant-launcher { position: fixed; z-index: 70; left: 50%; bottom: 20px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0; width: min(452px, calc(100vw - 36px)); min-height: 48px; padding: 5px; border: 1px solid color-mix(in srgb, var(--documentation-border-strong) 92%, var(--documentation-accent)); border-radius: 13px; background: color-mix(in srgb, var(--documentation-surface-raised) 96%, transparent); color: var(--documentation-text); box-shadow: 0 18px 45px rgba(15, 18, 28, .11), 0 2px 8px rgba(15, 18, 28, .05); transform: translateX(-50%); backdrop-filter: blur(18px) saturate(1.1); transition: border-color .16s, box-shadow .16s, transform .16s; }
.documentation-assistant-launcher:hover { border-color: color-mix(in srgb, var(--documentation-accent) 32%, var(--documentation-border-strong)); box-shadow: 0 20px 48px rgba(15, 18, 28, .14), 0 2px 8px rgba(15, 18, 28, .06); transform: translateX(-50%) translateY(-1px); }
.documentation-assistant-launcher input { min-width: 0; height: 36px; padding: 0 12px; border: 0; outline: 0; background: transparent; color: var(--documentation-text); font-size: 13px; }
.documentation-assistant-launcher input::placeholder { color: var(--documentation-muted); }
.documentation-launcher-agent, .documentation-launcher-send { display: grid; place-items: center; height: 36px; border: 0; border-radius: 9px; cursor: pointer; }
.documentation-launcher-agent { width: auto; padding: 0 13px 0 9px; border-right: 1px solid var(--documentation-border); border-radius: 0; background: transparent; color: var(--documentation-text-soft); font-size: 11.5px; font-weight: 650; white-space: nowrap; }
.documentation-launcher-agent:hover { color: var(--documentation-accent); }
.documentation-launcher-send { width: 36px; padding: 0; }
.documentation-launcher-send { background: var(--documentation-accent); color: #fff; }
.documentation-launcher-send:disabled { background: var(--documentation-panel); color: var(--documentation-faint); cursor: default; }
.documentation-launcher-send svg { width: 15px; }
.documentation-assistant { position: fixed; z-index: 90; left: 50%; bottom: 18px; display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; width: min(620px, calc(100vw - 36px)); height: min(570px, calc(100vh - 94px)); overflow: hidden; border: 1px solid var(--documentation-border-strong); border-radius: 16px; background: var(--documentation-surface); box-shadow: 0 28px 80px rgba(15, 18, 28, .18), 0 6px 22px rgba(15, 18, 28, .08); animation: documentation-assistant-in .2s ease-out; transform: translateX(-50%); }
.documentation-assistant > header { display: flex; align-items: center; justify-content: space-between; min-height: 54px; padding: 0 11px 0 18px; border-bottom: 1px solid var(--documentation-border); }
.documentation-assistant > header > div { display: flex; align-items: center; }
.documentation-assistant > header > div > span { display: grid; gap: 1px; }
.documentation-assistant > header strong { font-size: 13px; font-weight: 620; letter-spacing: -.01em; }
.documentation-assistant > header small { color: var(--documentation-muted); font-size: 10.5px; }
.documentation-assistant > header button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--documentation-muted); cursor: pointer; }
.documentation-assistant > header button:hover { background: var(--documentation-panel); color: var(--documentation-text); }
.documentation-assistant > header button:focus-visible { outline-width: 1px; outline-offset: 1px; }
.documentation-assistant > header button svg { width: 15px; height: 15px; }
.documentation-assistant-messages { overflow: auto; padding: 20px 20px 14px; overscroll-behavior: contain; }
.documentation-assistant-message { display: flex; align-items: flex-start; margin: 0 0 20px; color: var(--documentation-text-soft); font-size: 13px; line-height: 1.64; }
.documentation-assistant-message > div { min-width: 0; max-width: 590px; }
.documentation-assistant-message.is-user { justify-content: flex-end; margin-left: 54px; }
.documentation-assistant-message.is-user > div { padding: 8px 11px; border: 1px solid var(--documentation-border); border-radius: 10px; background: var(--documentation-panel); color: var(--documentation-text); }
.documentation-assistant-message.is-error > div { color: #c64b50; }
.documentation-assistant-message a { color: color-mix(in srgb, var(--documentation-accent) 79%, var(--documentation-text)); font-weight: 580; text-underline-offset: 3px; }
.documentation-assistant-markdown > :first-child { margin-top: 0; }
.documentation-assistant-markdown > :last-child { margin-bottom: 0; }
.documentation-assistant-markdown p { margin: 0 0 11px; }
.documentation-assistant-markdown ul, .documentation-assistant-markdown ol { margin: 0 0 12px; padding-left: 20px; }
.documentation-assistant-markdown li { margin: 3px 0; }
.documentation-assistant-heading { display: block; margin: 15px 0 6px; color: var(--documentation-text); font-family: var(--documentation-font-heading); font-size: 13px; }
.documentation-assistant-code { overflow: hidden; margin: 12px 0; border: 1px solid var(--documentation-border-strong); border-radius: 10px; background: var(--documentation-code-bg); color: var(--documentation-code-text); }
.documentation-assistant-code figcaption { display: flex; align-items: center; justify-content: space-between; min-height: 34px; padding: 0 8px 0 12px; border-bottom: 1px solid rgba(255,255,255,.09); background: var(--documentation-code-panel); color: #aeb5c6; font: 600 10.5px/1.3 var(--documentation-font-mono); }
.documentation-assistant-code button { padding: 4px 7px; border: 1px solid rgba(255,255,255,.1); border-radius: 6px; background: rgba(255,255,255,.06); color: inherit; cursor: pointer; font-size: 10px; }
.documentation-assistant-code pre { overflow: auto; margin: 0; padding: 13px; font: 11.5px/1.58 var(--documentation-font-mono); }
.documentation-assistant-code code { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; white-space: pre; }
.documentation-assistant-activity { display: inline-flex; align-items: center; gap: 8px; color: var(--documentation-muted); font-size: 12px; }
.documentation-assistant-activity > span { width: 6px; height: 6px; border-radius: 50%; background: var(--documentation-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--documentation-accent) 10%, transparent); animation: documentation-activity 1.25s ease-in-out infinite; }
.documentation-assistant-suggestions { display: grid; gap: 7px; margin-top: 26px; }
.documentation-assistant-suggestions p { margin: 0 0 1px; color: var(--documentation-faint); font-size: 10px; font-weight: 650; letter-spacing: .035em; text-transform: uppercase; }
.documentation-assistant-suggestions button { min-height: 38px; padding: 8px 11px; border: 1px solid var(--documentation-border); border-radius: 9px; background: var(--documentation-bg); color: var(--documentation-muted); cursor: pointer; font-size: 12px; text-align: left; transition: border-color .14s, background .14s, color .14s; }
.documentation-assistant-suggestions button:hover { border-color: var(--documentation-border-strong); background: var(--documentation-panel); color: var(--documentation-text); }
.documentation-assistant-composer { display: flex; align-items: flex-end; gap: 7px; margin: 0 16px 9px; padding: 7px; border: 1px solid var(--documentation-border-strong); border-radius: 11px; background: var(--documentation-bg); box-shadow: 0 3px 12px rgba(15, 18, 28, .045); }
.documentation-assistant-composer:focus-within { border-color: color-mix(in srgb, var(--documentation-accent) 52%, var(--documentation-border)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--documentation-accent) 9%, transparent); }
.documentation-assistant-composer textarea { min-height: 41px; max-height: 160px; flex: 1; padding: 4px 5px; resize: none; border: 0; outline: 0; background: transparent; color: var(--documentation-text); font-size: 12.5px; line-height: 1.5; }
.documentation-assistant-composer button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: var(--documentation-accent); color: white; cursor: pointer; }
.documentation-assistant-composer button:disabled { background: var(--documentation-panel-strong); color: var(--documentation-faint); cursor: default; }
.documentation-assistant > footer { padding: 0 18px 10px; color: var(--documentation-faint); font-size: 9.5px; text-align: center; }
@keyframes documentation-fade-in { from { opacity: 0; } }
@keyframes documentation-dialog-in { from { opacity: 0; transform: translateY(-8px) scale(.99); } }
@keyframes documentation-drawer-in { from { transform: translateX(-24px); } }
@keyframes documentation-assistant-in { from { transform: translateX(-50%) translateY(18px) scale(.985); opacity: .7; } }
@keyframes documentation-page-out { to { opacity: 0; transform: translateY(-3px); } }
@keyframes documentation-page-in { from { opacity: 0; transform: translateY(4px); } }
@keyframes documentation-activity { 50% { opacity: .42; transform: scale(.82); } }
@keyframes documentation-navigation-progress { from { transform: translateX(-20%); } to { transform: translateX(155%); } }

`
