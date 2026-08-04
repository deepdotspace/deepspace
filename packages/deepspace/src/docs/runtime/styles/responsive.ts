export const DOCS_RESPONSIVE_CSS = String.raw`
@media (max-width: 1320px) {
  .docs-reader-grid { grid-template-columns: minmax(0, 640px) 190px; gap: 48px; padding-inline: 70px; }
  .docs-top-links { gap: 13px; padding-right: 16px; }
  .docs-top-links a { font-size: 12px; }
}

@media (max-width: 1140px) {
  .docs-reader-grid { grid-template-columns: minmax(0, 760px); }
  .docs-context-rail { display: none; }
  .docs-header { grid-template-columns: var(--docs-sidebar-width) 1fr auto; }
  .docs-top-links { display: none; }
  .docs-breadcrumbs { display: flex; }
}

@media (max-width: 900px) {
  :root { --docs-sidebar-width: 0px; }
  .docs-header { grid-template-columns: minmax(0, 1fr) auto; }
  .docs-header > .docs-brand { padding-left: 17px; border-right: 0; }
  .docs-header-center, .docs-sidebar { display: none; }
  .docs-mobile-actions { display: flex; }
  .docs-main { margin-left: 0; }
  .docs-reader-grid { padding: 44px 30px 90px; }
  .docs-assistant { width: min(660px, calc(100vw - 24px)); }
}

@media (max-width: 600px) {
  body { font-size: 15px; }
  .docs-brand { padding-right: 8px; }
  .docs-brand-product { display: none; }
  .docs-mobile-actions { padding-right: 8px; }
  .docs-icon-button { width: 34px; }
  .docs-reader-grid { padding: 31px 19px 72px; }
  .docs-breadcrumbs { margin-bottom: 19px; overflow: hidden; white-space: nowrap; }
  .docs-breadcrumbs span { flex: 0 0 auto; }
  .docs-article-header { margin-bottom: 30px; }
  .docs-article-meta { align-items: flex-start; }
  .docs-eyebrow { padding-top: 8px; }
  .docs-contextual-primary button, .docs-contextual-primary a { max-width: 112px; overflow: hidden; text-overflow: ellipsis; }
  .docs-article-header h1 { font-size: 32px; line-height: 1.13; }
  .docs-lede { font-size: 17px; line-height: 1.52; }
  .docs-prose h2 { margin-top: 42px; font-size: 23px; }
  .docs-prose h3 { font-size: 18px; }
  .docs-prose pre { margin-inline: -5px; padding: 17px; border-radius: 10px; font-size: 12px; }
  .docs-code-actions { margin-right: -9px; margin-top: -9px; }
  .docs-pagination { grid-template-columns: 1fr; }
  .docs-feedback { align-items: flex-start; flex-wrap: wrap; }
  .docs-feedback > span { width: 100%; margin-bottom: 2px; }
  .docs-search-layer { padding: 8px; align-items: stretch; }
  .docs-search-dialog { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; border-radius: 12px; }
  .docs-search-results { max-height: none; }
  .docs-search-dialog > footer { justify-content: center; }
  .docs-assistant-launcher { bottom: 12px; width: calc(100vw - 20px); }
  .docs-assistant-launcher kbd { display: none; }
  .docs-assistant { bottom: 0; width: 100%; height: calc(100vh - 8px); border-width: 1px 0 0; border-radius: 18px 18px 0 0; }
  .docs-assistant-suggestions { grid-template-columns: 1fr; }
  .docs-playground-title { align-items: flex-start; flex-direction: column; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .001ms !important; }
}
`

