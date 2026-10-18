# Public-page SEO adoption

Applies to existing app-owned scaffolds without prerendering, per-page metadata,
or crawler files, and to copies of the prerender plugin whose noindex policy
blocks crawling or includes excluded pages in the sitemap. `app update` reports
`2026-10-public-page-seo`; it never changes indexing policy or source files.

An SDK dependency upgrade alone does not replace copied app source. Choose
which routes should be public and indexed before changing their robots metadata.
For an intentionally private app, keep its policy and record this guidance as
not applicable. Authentication remains the access boundary; noindex is not a
privacy or model-training control.

For public pages, adapt these files from the target release's scaffold together:

1. `prerender.ts` and `prerender()` in `vite.config.ts`, after
   `deepspaceBuild({ appDir })`.
2. `src/prerender-entry.tsx`, `src/seo.ts`, and `src/components/Seo.tsx`. List only
   public pages that render without auth/data providers. Set the verified public
   origin and render the page's `<Seo>` with its own title, description and path.
3. Remove static robots exclusions from `index.html` only after that policy
   decision. Remove metadata now owned by `<Seo>` to avoid conflicting tags.
   A client effect cannot reliably undo an initial HTML noindex directive.
4. The hydrate-or-render mount in `src/main.tsx` and the worker's `/_spa` then
   `/` fallback in `src/server/http-routes.ts`. Preserve custom routes, access
   checks and the real 404 behavior for missing files and reserved/API paths.
5. `public/robots.txt` and the prerender tests. Keep intentionally configured
   crawler restrictions under app ownership. Pages that must be removed from
   search need to remain crawlable so search engines can read their noindex.
6. Give the client catch-all page a robots noindex meta tag. It is a rendered
   exclusion, not a claim that the worker now returns HTTP 404 for all unknown
   client routes. Apps with a server route manifest should return real 404s.

The current prerender enforces site-wide noindex in emitted HTML even if a page
omits it, removes an existing sitemap for a noindex site, and excludes individual
noindex pages from a public sitemap. Update the copied plugin, not just the SDK.

Validate the app's type-check, unit tests and production build. Inspect initial
HTML for content and exactly one consistent title, description, canonical and
robots policy. Check the sitemap contains only intended indexable routes, and
that a noindex page can still be fetched. Verify hydration, navigation, direct
refresh of an authenticated route and the catch-all page in a browser. Confirm
private data is still gated. Record the migration only after these checks, then
deploy through the app's normal release process when authorized.

The source is the [scaffold prerender plugin](../../packages/create-deepspace/templates/base/prerender.ts).
Google documents [JavaScript and noindex](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)
and [crawlable noindex directives](https://developers.google.com/search/docs/crawling-indexing/block-indexing).
