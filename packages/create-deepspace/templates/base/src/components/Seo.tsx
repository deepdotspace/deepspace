import type { ReactElement } from 'react'

/**
 * Head tags for a public page: what search engines, AI answer engines, and
 * link previews read.
 *
 * Lives in the app, not the SDK, on purpose: importing anything from the
 * `deepspace` root pulls the SDK's client chunk (auth client and all) into the
 * landing page's bundle, and the static front door should stay light.
 *
 * `origin` and `path` together make the canonical URL
 * (`https://my-app.app.space/about`); a root-relative `ogImage` is resolved
 * against the same origin.
 */
export interface SeoProps {
  /** Browser tab and search-result headline. */
  title: string
  /** One plain sentence; shown under the title in results and previews. */
  description: string
  /** `https://host`, no trailing slash. Required for canonical / og:url. */
  origin?: string
  /** The page's path, starting with `/`. Required for canonical / og:url. */
  path?: string
  /** Preview image (1200×630). Absolute, or root-relative to `origin`. */
  ogImage?: string
  /** `og:type`; `website` unless the page is an article. */
  type?: 'website' | 'article'
  /** Ask crawlers not to list this page. */
  noindex?: boolean
}

/**
 * Renders the page's `<title>`, description, canonical, Open Graph, and
 * Twitter card tags. React 19 hoists `<title>`, `<meta>`, and `<link>` into
 * `<head>` from anywhere in the tree, so render it as the first child of the
 * page. prerender.ts stamps the same output into the static HTML at build, so
 * crawlers that do not execute JavaScript see it too.
 *
 * Routes that render no `<Seo>` must render a `<title>` of their own (the
 * `(app)` layout and the 404 page do): the prerendered page owns the document
 * title, and React removes it when this component unmounts.
 */
export function Seo({
  title,
  description,
  origin,
  path,
  ogImage,
  type = 'website',
  noindex = false,
}: SeoProps): ReactElement {
  const canonical = origin && path ? `${origin}${path}` : undefined
  const image = ogImage ? (ogImage.startsWith('/') && origin ? `${origin}${ogImage}` : ogImage) : undefined
  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
      {noindex ? <meta name="robots" content="noindex, nofollow" /> : null}
      {canonical ? <link rel="canonical" href={canonical} /> : null}
      <meta property="og:type" content={type} />
      {canonical ? <meta property="og:url" content={canonical} /> : null}
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      {image ? <meta property="og:image" content={image} /> : null}
      <meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      {image ? <meta name="twitter:image" content={image} /> : null}
    </>
  )
}
