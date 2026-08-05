export const DOCUMENTATION_RESPONSIVE_CSS = String.raw`
@media (max-width: 1320px) {
  .documentation-reader-grid { grid-template-columns: minmax(0, 640px) 190px; gap: 48px; padding-inline: 70px; }
  .documentation-top-links { gap: 13px; padding-right: 16px; }
  .documentation-top-links a { font-size: 12px; }
}

@media (max-width: 1140px) {
  .documentation-reader-grid { grid-template-columns: minmax(0, 760px); }
  .documentation-context-rail { display: none; }
  .documentation-header { grid-template-columns: var(--documentation-sidebar-width) 1fr auto; }
  .documentation-top-links { display: none; }
  .documentation-breadcrumbs { display: flex; }
}

@media (max-width: 900px) {
  :root { --documentation-sidebar-width: 0px; }
  .documentation-header { grid-template-columns: minmax(0, 1fr) auto; }
  .documentation-header > .documentation-brand { padding-left: 17px; border-right: 0; }
  .documentation-header-center, .documentation-sidebar { display: none; }
  .documentation-mobile-actions { display: flex; }
  .documentation-main { margin-left: 0; }
  .documentation-reader-grid { padding: 44px 30px 90px; }
  .documentation-assistant { width: min(660px, calc(100vw - 24px)); }
}

@media (max-width: 600px) {
  body { font-size: 15px; }
  .documentation-brand { padding-right: 8px; }
  .documentation-brand-product { display: none; }
  .documentation-mobile-actions { padding-right: 8px; }
  .documentation-icon-button { width: 34px; }
  .documentation-reader-grid { padding: 31px 19px 72px; }
  .documentation-breadcrumbs { margin-bottom: 19px; overflow: hidden; white-space: nowrap; }
  .documentation-breadcrumbs span { flex: 0 0 auto; }
  .documentation-article-header { margin-bottom: 30px; }
  .documentation-article-meta { align-items: flex-start; }
  .documentation-eyebrow { padding-top: 8px; }
  .documentation-contextual-primary button, .documentation-contextual-primary a { max-width: 112px; overflow: hidden; text-overflow: ellipsis; }
  .documentation-article-header h1 { font-size: 32px; line-height: 1.13; }
  .documentation-lede { font-size: 17px; line-height: 1.52; }
  .documentation-prose h2 { margin-top: 42px; font-size: 23px; }
  .documentation-prose h3 { font-size: 18px; }
  .documentation-prose pre { margin-inline: -5px; padding: 17px; border-radius: 10px; font-size: 12px; }
  .documentation-code-actions { margin-right: -9px; margin-top: -9px; }
  .documentation-pagination { grid-template-columns: 1fr; }
  .documentation-app.has-assistant .documentation-pagination { margin-bottom: 124px; transform: translateY(124px); }
  .documentation-feedback { align-items: flex-start; flex-wrap: wrap; }
  .documentation-feedback > span { width: 100%; margin-bottom: 2px; }
  .documentation-search-layer { padding: 8px; align-items: stretch; }
  .documentation-search-dialog { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; border-radius: 12px; }
  .documentation-search-results { max-height: none; }
  .documentation-search-dialog > footer { justify-content: center; }
  .documentation-assistant-launcher { bottom: 12px; width: calc(100vw - 20px); }
  .documentation-assistant-launcher kbd { display: none; }
  .documentation-assistant { bottom: 0; width: 100%; height: calc(100vh - 8px); border-width: 1px 0 0; border-radius: 18px 18px 0 0; }
  .documentation-assistant-suggestions { grid-template-columns: 1fr; }
  .documentation-playground-title { align-items: flex-start; flex-direction: column; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .001ms !important; }
}
`
