import { describe, expect, it } from 'vitest'
import { PRERENDER_ROUTES, render } from './prerender-entry'

/**
 * Every public page must render without a browser — that is what lets
 * prerender.ts turn it into static HTML at `vite build`. `deepspace dev`
 * never prerenders, so without this test the first sign of a page touching
 * `window`, `localStorage`, or `matchMedia` during render would be a failed
 * deploy. Runs in Node in about a second (`npm run test:unit`).
 */
describe('public pages prerender', () => {
  it.each(PRERENDER_ROUTES)('%s renders to static HTML with a title and a body', (route) => {
    const html = render(route)
    expect(html, `${route} rendered no <title> — render <Seo {...seo} path="${route}" /> first`).toMatch(/<title>[^<]+<\/title>/)
    expect(html).toContain('name="description"')
    const at = html.indexOf('<div data-testid="app-root"')
    expect(at, `${route} rendered no app-root — src/pages/_app.tsx root markup changed?`).toBeGreaterThan(-1)
    // Markup beyond the root wrapper itself: a page that renders nothing
    // without a browser would ship an empty static page.
    expect(html.slice(at)).toMatch(/<(h1|h2|p|main|section|article|a)\b/)
  })
})
