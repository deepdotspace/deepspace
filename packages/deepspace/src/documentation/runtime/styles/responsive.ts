export const DOCUMENTATION_RESPONSIVE_CSS = String.raw`
@media (max-width: 1320px) {
  .documentation-reader-grid { grid-template-columns: minmax(0, 680px) 224px; gap: 48px; padding-inline: 70px; }
  .documentation-top-links { gap: 13px; padding-right: 16px; }
  .documentation-top-links a { font-size: 13px; }
}

/* The rail's own cut-off is 1140px; a docked panel takes that much again out of
 * the row, so the same choice applies that much earlier while it is open. */
@media (max-width: 1560px) {
  .documentation-app.is-assistant-open .documentation-reader-grid { grid-template-columns: minmax(0, 760px); }
  .documentation-app.is-assistant-open .documentation-context-rail { display: none; }
}

@media (max-width: 1140px) {
  .documentation-reader-grid { grid-template-columns: minmax(0, 760px); }
  .documentation-context-rail { display: none; }
  .documentation-header { grid-template-columns: var(--documentation-sidebar-width) 1fr auto; }
  .documentation-top-links { display: none; }
  .documentation-breadcrumbs { display: flex; }
  .documentation-outline-disclosure { display: block; }
  /* Too narrow to dock beside the article; fall back to the floating card. */
  .documentation-assistant { inset: auto auto 18px 50%; width: min(620px, calc(100vw - 36px)); height: min(570px, calc(100vh - 94px)); border: 1px solid var(--documentation-border-strong); border-radius: 16px; box-shadow: 0 28px 80px rgba(15, 18, 28, .18), 0 6px 22px rgba(15, 18, 28, .08); transform: translateX(-50%); animation: documentation-assistant-in .2s ease-out; }
  .documentation-app.is-assistant-open .documentation-main { margin-right: 0; }
  .documentation-app.is-assistant-open .documentation-header { right: 0; }
}

@media (max-width: 900px) {
  :root { --documentation-sidebar-width: 0px; }
  .documentation-header { grid-template-columns: minmax(0, 1fr) auto; }
  .documentation-header > .documentation-brand { padding-left: 17px; border-right: 0; }
  .documentation-header-center, .documentation-sidebar { display: none; }
  .documentation-mobile-actions { display: flex; }
  .documentation-main { margin-left: 0; }
  .documentation-reader-grid { padding: 44px 30px 64px; }
  .documentation-assistant { width: min(660px, calc(100vw - 24px)); }
}

@media (max-width: 600px) {
  body { font-size: 16px; }
  .documentation-brand { padding-right: 8px; }
  .documentation-brand-product { display: none; }
  .documentation-mobile-actions { padding-right: 8px; }
  .documentation-icon-button { width: 44px; height: 44px; }
  .documentation-reader-grid { padding: 31px 19px 48px; }
  .documentation-breadcrumbs { margin-bottom: 19px; overflow: hidden; white-space: nowrap; }
  .documentation-breadcrumbs span { flex: 0 0 auto; }
  .documentation-article-header { margin-bottom: 30px; }
  .documentation-article-meta { align-items: flex-start; }
  .documentation-eyebrow { padding-top: 8px; }
  .documentation-contextual-primary button, .documentation-contextual-primary a { max-width: 112px; overflow: hidden; text-overflow: ellipsis; }
  .documentation-article-header h1 { font-size: 32px; line-height: 1.15; }
  .documentation-lede { font-size: 18px; line-height: 1.52; }
  .documentation-prose h2 { margin-top: 42px; font-size: 23px; }
  .documentation-prose h3 { font-size: 19px; }
  .documentation-prose pre { margin-inline: -5px; padding: 17px; border-radius: 10px; font-size: 13px; }
  .documentation-pagination { grid-template-columns: 1fr; }
  .documentation-search-layer { padding: 8px; align-items: stretch; }
  .documentation-search-dialog { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; border-radius: 12px; }
  .documentation-search-results { max-height: none; }
  .documentation-search-dialog > footer { justify-content: center; }
  .documentation-launcher-dock { padding-bottom: 12px; }
  .documentation-launcher-agent { padding: 0 9px; }
  .documentation-launcher-agent .documentation-launcher-agent-name { display: none; }
  .documentation-launcher-hint { display: none; }
  .documentation-assistant { inset: auto auto 0 0; width: 100%; height: calc(100vh - 8px); transform: none; border-width: 1px 0 0; border-radius: 18px 18px 0 0; }
  .documentation-assistant-suggestions { grid-template-columns: 1fr; }
  .documentation-playground-title { align-items: flex-start; flex-direction: column; }
}

/* Hover-only affordances: touch users get no reveal, so keep the space clear. */
@media (hover: none) {
  .documentation-prose .documentation-heading-anchor { display: none; }
  .documentation-code-actions { opacity: 1; }
  .documentation-launcher-hint { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .001ms !important; }
}
`
