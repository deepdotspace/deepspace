/**
 * Build-time prerender of the public pages (the approach deep.space uses).
 *
 * A DeepSpace app is a client-rendered SPA: `dist/client/index.html` is an
 * empty `<div id="root">`, so a crawler that does not run JavaScript (Bing,
 * link unfurlers, every AI answer engine) reads a blank page with a bare
 * title. After `vite build` writes the client bundle, this plugin renders the
 * pages listed in src/prerender-entry.tsx with react-dom/server and writes:
 *
 *   - `<route>.html` per page (`/` → index.html, `/about` → about.html), the
 *     built template with the page's <Seo> head stamped in and #root filled.
 *     FLAT, not `about/index.html`: the platform's asset layer runs
 *     Cloudflare's default `html_handling: auto-trailing-slash`, which serves
 *     about.html at /about (200) — a nested file would 307 /about → /about/
 *     and contradict the page's canonical URL.
 *   - `_spa.html`, the untouched empty shell. src/server/http-routes.ts serves
 *     it for client routes (/home, /settings, …) so a refresh there never
 *     paints the landing page or hands crawlers the `/` canonical.
 *   - `sitemap.xml`, and the `Sitemap:` line appended to public/robots.txt's
 *     copy — or `Disallow: /` and no sitemap when src/seo.ts says `noindex`.
 *
 * Why a Vite plugin: `deepspace deploy` runs `npx vite build` directly, never
 * package.json scripts, so this is the only seam that runs at deploy time.
 * `deepspace dev` never runs it — dev serves the SPA; <Seo> still sets the
 * head at runtime. Delete `prerender()` from vite.config.ts for a plain SPA.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as viteBuild, type Plugin, type ResolvedConfig } from 'vite'
import react from '@vitejs/plugin-react'

const appDir = fileURLToPath(new URL('.', import.meta.url))
const ENTRY = 'src/prerender-entry.tsx'
const SHELL_FILE = '_spa.html'
const ROOT_PLACEHOLDER = '<div id="root"></div>'
/** src/pages/_app.tsx's root element; React 19 puts hoisted head tags before it. */
const BODY_ANCHOR = '<div data-testid="app-root"'
/** Re-entrancy guard: the nested SSR build must not run this plugin again. */
const PASS_ENV = 'DEEPSPACE_PRERENDER_PASS'

/** What the built src/prerender-entry.tsx exports. */
interface Entry {
  PRERENDER_ROUTES: readonly string[]
  render(route: string): string
  seo: { origin: string; noindex: boolean }
}

/**
 * Public origin every canonical URL and the sitemap hang off. `deepspace
 * deploy` sets DEEPSPACE_SITE_ORIGIN for the build it runs (staging resolves
 * to spacestest.com); a plain `vite build` derives it from wrangler.toml's
 * top-level `name`. src/seo.ts reads it as `__DEEPSPACE_SITE_ORIGIN__` and is
 * the place to override it once a custom domain is attached.
 */
function siteOrigin(): string {
  if (process.env.DEEPSPACE_SITE_ORIGIN) return process.env.DEEPSPACE_SITE_ORIGIN
  const name = /^name\s*=\s*"([^"]+)"/m.exec(readFileSync(join(appDir, 'wrangler.toml'), 'utf8'))?.[1]
  return name ? `https://${name}.app.space` : 'http://localhost'
}

export function prerender(): Plugin {
  let config: ResolvedConfig
  let ran = false

  return {
    name: 'prerender',
    enforce: 'post',
    config() {
      return { define: { __DEEPSPACE_SITE_ORIGIN__: JSON.stringify(siteOrigin()) } }
    },
    configResolved(resolved) {
      config = resolved
    },
    async closeBundle() {
      if (config.command !== 'build' || ran || process.env[PASS_ENV]) return
      // The Cloudflare plugin builds the worker environments first and the
      // client last, each with its own closeBundle. Only the client's output
      // has the template, so run on that environment alone (matched by its
      // output dir, the thing this plugin actually depends on).
      const clientDir = join(config.root, 'dist', 'client')
      const envOutDir = this.environment?.config?.build?.outDir
      if (envOutDir ? resolve(config.root, envOutDir) !== clientDir : this.environment?.name !== 'client') return
      ran = true

      const templatePath = join(clientDir, 'index.html')
      const template = readFileSync(templatePath, 'utf8')
      if (!template.includes(ROOT_PLACEHOLDER)) {
        throw new Error(`[prerender] dist/client/index.html has no '${ROOT_PLACEHOLDER}' to fill — keep the scaffold's empty root container.`)
      }

      // 1. Isolated SSR pass with the same defines (app id, site origin) and
      //    alias the client saw: no config file, no cloudflare(), no
      //    generouted(), and (via PASS_ENV) not this plugin.
      const ssrDir = join(config.root, 'dist', 'prerender')
      process.env[PASS_ENV] = '1'
      try {
        await viteBuild({
          configFile: false,
          root: config.root,
          mode: 'production',
          logLevel: 'warn',
          define: config.define,
          resolve: { alias: { '@': join(config.root, 'src') }, dedupe: ['react', 'react-dom'] },
          plugins: [react()],
          build: {
            ssr: join(config.root, ENTRY),
            outDir: ssrDir,
            emptyOutDir: true,
            rollupOptions: { output: { entryFileNames: 'entry.mjs' } },
          },
        })
      } finally {
        delete process.env[PASS_ENV]
      }
      const entry = (await import(pathToFileURL(join(ssrDir, 'entry.mjs')).href)) as Entry
      const { origin, noindex } = entry.seo

      // 2. The plain shell first, from the untouched template.
      writeFileSync(join(clientDir, SHELL_FILE), noindex ? withNoindexMeta(template) : template)

      // 3. Each page, in the order PAGES lists them (the template was read above,
      //    so overwriting index.html here is safe in any order).
      const routes = entry.PRERENDER_ROUTES
      for (const route of routes) {
        const html = entry.render(route)
        const at = html.indexOf(BODY_ANCHOR)
        if (at < 0) throw new Error(`[prerender] ${route} rendered no '${BODY_ANCHOR}' — src/pages/_app.tsx root markup changed?`)
        const head = html.slice(0, at)
        const body = html.slice(at)
        if (!head.includes('<title>') || !head.includes('name="description"')) {
          throw new Error(`[prerender] ${route} rendered no <title>/description — render <Seo {...seo} path="${route}" /> first in the page.`)
        }
        if (!body.includes('<h') && !body.includes('<p')) {
          throw new Error(`[prerender] ${route} rendered an empty page — public pages must return markup without a browser.`)
        }
        const page = stampHead(template, head).replace(
          ROOT_PLACEHOLDER,
          // Replacer FUNCTION: a replacement STRING would expand `$&`/`$$`
          // appearing in the page's copy. data-prerendered tells src/main.tsx
          // to hydrate this markup instead of repainting it.
          () => `<div id="root" data-prerendered="${route}">${body}</div>`,
        )
        if (page.includes('__DEEPSPACE_APP_ID__')) {
          throw new Error(`[prerender] ${route} contains the literal __DEEPSPACE_APP_ID__; the deploy would refuse it.`)
        }
        const file = join(clientDir, route === '/' ? 'index.html' : `${route.slice(1)}.html`)
        // `/legal/privacy` → legal/privacy.html; writeFileSync does not create the folder.
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, page)
      }

      // 4. Crawler files. robots.txt is the app's own policy (public/), plus
      //    the one line only the build knows.
      const robotsPath = join(clientDir, 'robots.txt')
      if (noindex) {
        writeFileSync(robotsPath, 'User-agent: *\nDisallow: /\n')
      } else {
        const robots = existsSync(robotsPath) ? readFileSync(robotsPath, 'utf8') : 'User-agent: *\nAllow: /\n'
        if (!/^Sitemap:/m.test(robots)) writeFileSync(robotsPath, `${robots.trimEnd()}\n\nSitemap: ${origin}/sitemap.xml\n`)
        writeFileSync(
          join(clientDir, 'sitemap.xml'),
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes
            .map((route) => `  <url><loc>${origin}${route}</loc></url>`)
            .join('\n')}\n</urlset>\n`,
        )
      }

      rmSync(ssrDir, { recursive: true, force: true })
      console.log(`[prerender] wrote ${routes.length} page(s) [${routes.join(', ')}], ${SHELL_FILE}, robots.txt${noindex ? ' (noindex)' : ', sitemap.xml'}`)
    },
  }
}

/**
 * Swap the template's default head tags for the page's hoisted <Seo> output:
 * strip the tags <Seo> owns (title, description, robots, canonical, og:/
 * twitter:) and keep everything else (charset, viewport, icon, hashed assets,
 * the first-paint style, any theme script). Fails if a strip no-ops — a
 * changed tag shape would otherwise ship two conflicting titles.
 */
function stampHead(template: string, head: string): string {
  const stripped = template
    .replace(/<title>[\s\S]*?<\/title>\s*/g, '')
    .replace(/<meta\s+name="(?:description|robots)"[^>]*>\s*/g, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/g, '')
    .replace(/<meta\s+(?:property|name)="(?:og|twitter):[^>]*>\s*/g, '')
  for (const leftover of ['<title', 'name="description"', 'rel="canonical"', 'property="og:']) {
    if (stripped.includes(leftover)) {
      throw new Error(`[prerender] could not strip '${leftover}' from index.html — keep its head to the scaffold's shape and put SEO tags in <Seo>.`)
    }
  }
  return stripped.replace('</head>', () => `${head}\n  </head>`)
}

function withNoindexMeta(template: string): string {
  return template.replace('</head>', () => `<meta name="robots" content="noindex, nofollow"/>\n  </head>`)
}
