import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The SEO scaffolding a new app ships, pinned as bytes.
 *
 * Crawlers that do not run JavaScript (Bing, link unfurlers, AI answer
 * engines) read only what `vite build` writes, so the pieces below have to
 * hold together: `src/seo.ts` is the one source, `<Seo>` renders it at
 * runtime, the scaffold's own prerender.ts stamps it into static HTML, and
 * `public/robots.txt` is the crawler policy the build appends a Sitemap to.
 */
const TEMPLATES = new URL('../../templates/', import.meta.url)
const OVERLAYS = ['starter', 'copilot']

function template(path: string): string {
  return readFileSync(new URL(path, TEMPLATES), 'utf8')
}

describe('scaffold SEO source of truth', () => {
  const seo = template('base/src/seo.ts')

  it('ships indexable by default and reads the build-injected origin', () => {
    expect(seo).toContain('noindex: false')
    expect(seo).toContain('__DEEPSPACE_SITE_ORIGIN__')
    expect(seo).toContain("import { APP_NAME } from './constants'")
  })

  it('opts the build into prerendering', () => {
    const vite = template('base/vite.config.ts')
    expect(vite).toContain("import { prerender } from './prerender.ts'")
    expect(vite).toMatch(/^\s*prerender\(\),$/m)
  })

  it('ships the prerender plugin and its render entry as app code', () => {
    // deep.space's approach, in the scaffold: a root-level Vite plugin and an
    // explicit page list — no SDK build dependency to keep in step.
    const plugin = template('base/prerender.ts')
    expect(plugin).toContain("from 'vite'")
    expect(plugin).toContain("const SHELL_FILE = '_spa.html'")
    expect(plugin).toContain('DEEPSPACE_SITE_ORIGIN')
    expect(plugin).toContain('__DEEPSPACE_SITE_ORIGIN__')
    expect(plugin).toContain('data-prerendered=')

    const entry = template('base/src/prerender-entry.tsx')

    // Early feedback: `deepspace dev` never prerenders, so a Node render of
    // every public page runs in the unit suite before any deploy.
    const unit = template('base/src/prerender-entry.test.tsx')
    expect(unit).toContain("from './prerender-entry'")
    expect(unit).toContain('it.each(PRERENDER_ROUTES)')
    expect(entry).toContain("import Landing from './pages/index'")
    expect(entry).toContain("'/': Landing")
    expect(entry).toContain("export { seo } from './seo'")
    expect(entry).toContain("from 'react-dom/server'")
  })
})

describe('scaffold <Seo> component', () => {
  it('ships in the app and renders the head tags the prerender splits on', () => {
    const seo = template('base/src/components/Seo.tsx')
    expect(seo).toContain('export function Seo(')
    for (const tag of ['<title>{title}</title>', 'name="description"', 'rel="canonical"', 'property="og:title"', 'name="twitter:card"']) {
      expect(seo).toContain(tag)
    }
  })

  it('gives the 404 page its own <title>', () => {
    expect(template('base/src/pages/[...all].tsx')).toContain('<title>')
  })
})

describe('scaffold robots.txt', () => {
  const robots = template('base/public/robots.txt')

  it('welcomes search engines and AI answer-engine crawlers', () => {
    expect(robots).toMatch(/^User-agent: \*\nAllow: \/$/m)
    for (const bot of [
      'Googlebot',
      'Bingbot',
      'GPTBot',
      'OAI-SearchBot',
      'ChatGPT-User',
      'PerplexityBot',
      'ClaudeBot',
      'Google-Extended',
      'CCBot',
    ]) {
      expect(robots, `robots.txt must allow ${bot}`).toContain(`User-agent: ${bot}\nAllow: /`)
    }
    // The header comment explains `Disallow: /`; no directive line uses it.
    expect(robots).not.toMatch(/^Disallow:/m)
  })

  it('leaves the Sitemap line to the build, which alone knows the origin', () => {
    expect(robots).not.toMatch(/^Sitemap:/m)
  })
})

describe.each(OVERLAYS)('%s overlay head', (overlay) => {
  it('keeps index.html free of tags <Seo> owns', () => {
    // React 19 does not dedupe hoisted metadata against static head tags on a
    // client mount, so a static description or canonical would ship twice on
    // client-rendered routes. The prerender stamps them for `/`; <Seo> hoists
    // them at runtime. The static <title> stays as the shell's fallback and is
    // replaced on prerendered pages.
    const html = template(`${overlay}/index.html`)
    expect(html.match(/<title>/g)).toHaveLength(1)
    expect(html).not.toContain('name="description"')
    expect(html).not.toContain('rel="canonical"')
    expect(html).toContain('<div id="root"></div>')
  })

  it('renders <Seo> from the app copy, not the SDK root', () => {
    // The root barrel drags the SDK client chunk into the landing bundle;
    // the static front door stays light by owning the 1 KB component.
    const landing = template(`${overlay}/src/pages/index.tsx`)
    expect(landing).toContain("import { Seo } from '../components/Seo'")
    expect(landing).not.toContain("from 'deepspace'")
  })

  it('sets a fallback <title> on the app layout, which renders no <Seo>', () => {
    // The prerendered landing owns the document title and React removes it
    // when <Seo> unmounts on a client-side navigation.
    const layout = template(`${overlay}/src/pages/(app)/_layout.tsx`)
    expect(layout).toContain('<title>{APP_NAME}</title>')
  })
})
