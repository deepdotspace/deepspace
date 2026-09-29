/**
 * Public-page SEO — what search engines, AI answer engines, and link previews
 * see for this app.
 *
 * Two consumers read this file, so the values can never disagree:
 *   - `<Seo {...seo} path="/" />` in src/pages/index.tsx renders them at
 *     runtime (React 19 hoists <title>/<meta>/<link> into <head>);
 *   - prerender.ts (app root, via vite.config.ts) stamps them into the static
 *     HTML at `vite build`, so crawlers that do not run JavaScript still get a
 *     real title, description, and canonical URL.
 *
 * Fill `title` and `description` when you design the landing page: a headline
 * with a category descriptor ("Acme | Team task boards") and one plain
 * sentence of about 150 characters. Set `noindex: true` for an app that
 * should stay out of search engines and AI crawlers entirely (the build then
 * publishes a Disallow-all robots.txt and no sitemap).
 */

import { APP_NAME } from './constants'

/** Injected by prerender.ts: `https://<name>.app.space` from wrangler.toml, or
 *  what `deepspace deploy` passes (staging: spacestest.com). Absent in unit
 *  tests, hence the guard. */
declare const __DEEPSPACE_SITE_ORIGIN__: string | undefined

export const seo = {
  title: APP_NAME,
  description: `${APP_NAME} is a real-time collaborative app.`,
  /** Public origin for canonical URLs, og:url, and the sitemap — no trailing
   *  slash. Replace with the custom domain once one is attached, e.g.
   *  'https://www.example.com'. */
  origin: typeof __DEEPSPACE_SITE_ORIGIN__ === 'string' ? __DEEPSPACE_SITE_ORIGIN__ : 'http://localhost',
  /** 1200×630 preview image, root-relative to public/ (e.g. '/og.png'). */
  // ogImage: '/og.png',
  noindex: false,
}
