import { expect, test, type Page } from '@playwright/test'

/**
 * Chrome geometry and type scale, asserted against the rendered box model rather
 * than the stylesheet, so a broken flex or sticky chain is caught where it shows
 * up. Runs against both runtimes: the executable runtime wraps the shell in an
 * app-owned `documentation.tsx`, and the layout has to survive that.
 */

test.use({ viewport: { width: 1440, height: 900 } })

async function hydrate(page: Page): Promise<void> {
  await page.goto('/docs')
  await expect(page.locator('#deepspace-documentation-root')).toHaveAttribute(
    'data-documentation-hydrated',
    'true',
  )
}

test('the sidebar footer is pinned to the bottom of the rail', async ({ page }) => {
  await hydrate(page)
  const sidebar = await page.locator('.documentation-sidebar').boundingBox()
  const footer = await page.locator('.documentation-sidebar-footer').boundingBox()
  const tree = await page.locator('.documentation-page-tree').boundingBox()
  expect(sidebar).not.toBeNull()
  expect(footer).not.toBeNull()
  expect(tree).not.toBeNull()
  // The tree is the flexible scroller and the footer sits on the rail's bottom
  // edge, rather than trailing directly under the last nav item.
  expect(Math.abs((sidebar!.y + sidebar!.height) - (footer!.y + footer!.height))).toBeLessThanOrEqual(1)
  expect(Math.abs(footer!.y - (tree!.y + tree!.height))).toBeLessThanOrEqual(1)
  expect(await page.locator('.documentation-page-tree').evaluate((node) =>
    getComputedStyle(node).overflowY)).toMatch(/auto|scroll/)
})

test('the assistant launcher docks to the viewport bottom while reading', async ({ page }) => {
  await hydrate(page)
  await page.evaluate(() => window.scrollTo({ top: 800, behavior: 'instant' }))
  await page.waitForTimeout(200)
  const dock = await page.locator('.documentation-launcher-dock').boundingBox()
  const viewport = page.viewportSize()!
  expect(dock, 'the launcher dock renders while reading').not.toBeNull()
  expect(
    Math.abs(viewport.height - (dock!.y + dock!.height)),
    'the dock bottom sits on the viewport bottom mid-article',
  ).toBeLessThanOrEqual(2)
  expect(await page.locator('.documentation-launcher-dock').evaluate((node) =>
    getComputedStyle(node).position)).toBe('sticky')

  // At the end of the article it settles into its in-flow slot above the
  // pagination — still fully present and interactive. The end of a page is
  // exactly where questions form, so there is no auto-hide.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }))
  await page.waitForTimeout(200)
  const pagination = await page.locator('.documentation-pagination').boundingBox()
  const docked = await page.locator('.documentation-launcher-dock').boundingBox()
  expect(docked!.y + docked!.height).toBeLessThanOrEqual(pagination!.y + 1)
  const launcher = page.locator('.documentation-assistant-launcher')
  await expect(launcher).toBeVisible()
  const settled = await launcher.evaluate((node) => {
    const style = getComputedStyle(node)
    return { opacity: style.opacity, pointerEvents: style.pointerEvents }
  })
  expect(settled.opacity).toBe('1')
  expect(settled.pointerEvents).not.toBe('none')
})

test('the launcher is a single input row — no chip, accessible name intact', async ({ page }) => {
  await hydrate(page)
  await expect(page.locator('.documentation-launcher-agent')).toHaveCount(0)
  const input = page.locator('.documentation-assistant-launcher input')
  await expect(input).toBeVisible()
  const name = await input.getAttribute('aria-label')
  expect(name).toMatch(/agent$/)
  // The input owns the row: it spans most of the launcher width.
  const inputBox = await input.boundingBox()
  const launcher = await page.locator('.documentation-assistant-launcher').boundingBox()
  expect(inputBox!.width).toBeGreaterThan(launcher!.width * 0.5)
})

test('anchors land at the single scroll-padding clearance — no stacked offsets', async ({ page }) => {
  await hydrate(page)
  await page.evaluate(() => {
    document.querySelector<HTMLAnchorElement>('.documentation-outline a')?.click()
  })
  await page.waitForTimeout(700)
  const landing = await page.evaluate(() => {
    const id = decodeURIComponent(location.hash.slice(1))
    const target = document.getElementById(id)
    return {
      top: target ? Math.round(target.getBoundingClientRect().top) : null,
      scrollPadding: getComputedStyle(document.documentElement).scrollPaddingTop,
      scrollMargin: target ? getComputedStyle(target).scrollMarginTop : null,
    }
  })
  expect(landing.scrollPadding).toBe('96px')
  expect(landing.scrollMargin, 'clearance is owned once, by the container').toBe('0px')
  expect(Math.abs((landing.top ?? 0) - 96), 'anchor target sits at the clearance line').toBeLessThanOrEqual(2)
})

test('clicking every outline entry moves the highlight to it — including the last', async ({ page }) => {
  await hydrate(page)
  const hrefs: string[] = await page.$$eval('.documentation-outline a', (nodes) =>
    nodes.map((node) => node.getAttribute('href') ?? ''))
  expect(hrefs.length).toBeGreaterThan(2)
  // The last entry is the one an intersection-band spy could never activate
  // when its section is short; walk them all, ending on it.
  for (const href of [...hrefs.slice(0, 2), hrefs[hrefs.length - 2]!, hrefs[hrefs.length - 1]!]) {
    await page.evaluate((target) => {
      document.querySelector<HTMLAnchorElement>(`.documentation-outline a[href="${target}"]`)?.click()
    }, href)
    await page.waitForTimeout(750)
    const active = await page.evaluate(() =>
      document.querySelector('.documentation-outline a.is-active')?.getAttribute('href') ?? null)
    expect(active, `outline highlight follows a click on ${href}`).toBe(href)
  }
})

test('the search trigger matches the surrounding chrome type scale', async ({ page }) => {
  await hydrate(page)
  const typography = async (selector: string): Promise<{ family: string; size: string }> =>
    page.locator(selector).first().evaluate((node) => {
      const style = getComputedStyle(node)
      return { family: style.fontFamily, size: style.fontSize }
    })
  const trigger = await typography('.documentation-search-trigger span')
  const navLink = await typography('.documentation-nav-link span')
  expect(trigger.family).toBe(navLink.family)
  expect(trigger.size).toBe(navLink.size)
})

test('header and sidebar icon controls keep a comfortable rhythm', async ({ page }) => {
  await hydrate(page)
  const gaps = await page.locator('.documentation-theme-controls').evaluate((group) => {
    const rects = Array.from(group.querySelectorAll('button')).map((b) => b.getBoundingClientRect())
    return rects.slice(1).map((rect, index) => Math.round(rect.left - rects[index].right))
  })
  expect(gaps.length).toBeGreaterThan(0)
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(2)
  // Consistent, not merely non-zero.
  expect(new Set(gaps).size).toBe(1)
})
