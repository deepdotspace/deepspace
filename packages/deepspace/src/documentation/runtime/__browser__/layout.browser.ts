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

  // It still scrolls away above the pagination at the end of the article.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }))
  await page.waitForTimeout(200)
  const pagination = await page.locator('.documentation-pagination').boundingBox()
  const docked = await page.locator('.documentation-launcher-dock').boundingBox()
  expect(docked!.y + docked!.height).toBeLessThanOrEqual(pagination!.y + 1)
})

test('the launcher chip never truncates, whatever the site is called', async ({ page }) => {
  await hydrate(page)
  const chip = page.locator('.documentation-launcher-agent')
  await expect(chip).toBeVisible()
  const label = page.locator('.documentation-launcher-agent-name')
  const overflow = await label.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }))
  expect(
    overflow.scrollWidth,
    'the chip label fits without ellipsis at any configured site name length',
  ).toBeLessThanOrEqual(overflow.clientWidth)
  // The accessible name still identifies the site, even though the chip does not.
  const name = await chip.getAttribute('aria-label')
  expect(name).toMatch(/agent$/)
  // The 40% column clamp stays a guard, not the thing that sizes the chip.
  const chipBox = await chip.boundingBox()
  const launcher = await page.locator('.documentation-assistant-launcher').boundingBox()
  expect(chipBox!.width).toBeLessThan(launcher!.width * 0.4)
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
