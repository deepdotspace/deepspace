/**
 * Build-time render entry for prerender.ts (at the app root). Never shipped to
 * the browser and never run by `deepspace dev`.
 *
 * PAGES lists the public pages — the ones at the top level of src/pages/ that
 * render with no DeepSpace providers. Add a page here when you add one, and it
 * is prerendered to static HTML and listed in sitemap.xml. Pages under
 * src/pages/(app)/ mount auth and realtime and cannot be prerendered.
 *
 * The tree below must mirror what generouted renders on the client for these
 * routes, or hydration mismatches: root route = _app's default export, then a
 * literal space, then the (empty) modals slot. See
 * node_modules/@generouted/react-router/dist/index-lazy.js before changing it.
 */

import type { ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
// From react-router-dom, like the pages: under Vitest the two entry points
// load as separate module instances, and a router created from one is
// invisible to <Outlet>/<Link> imported from the other.
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import * as app from './pages/_app'
import Landing from './pages/index'

// prerender.ts reads `origin` (canonical URLs, sitemap) and `noindex` from here.
export { seo } from './seo'

export const PAGES: Record<string, ComponentType> = {
  '/': Landing,
}

export const PRERENDER_ROUTES = Object.keys(PAGES)

const App = app.default

function Layout() {
  return (
    <>
      <App />{' '}
      <></>
    </>
  )
}

/** Render one route. React 19 hoists <title>/<meta>/<link> to the START of the
 *  output, before _app's root element; prerender.ts splits them apart. */
export function render(route: string): string {
  const router = createMemoryRouter(
    [
      {
        Component: Layout,
        ErrorBoundary: app.Catch,
        children: PRERENDER_ROUTES.map((path) => ({ path, Component: PAGES[path] })),
      },
    ],
    { initialEntries: [route] },
  )
  return renderToString(<RouterProvider router={router} />)
}
