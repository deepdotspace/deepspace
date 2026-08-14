import { expect, test, type Page } from '@playwright/test'

/**
 * The DOM-ownership and swap-integrity gate. It runs against both runtimes —
 * the default runtime injects the compiler's HTML, the executable runtime
 * renders the prose with React. Every route swap commits through one
 * synchronous `flushSync`; there is deliberately no view-transition or
 * motion-dependent branch left in the router, so one code path is the whole
 * surface under test.
 *
 * Two independent failure signals: any uncaught error or `console.error` during
 * navigation, and a direct check that no React-owned node has drifted away from
 * the parent its fiber records. The second catches a reparenting regression
 * even on a page where nothing happens to crash.
 */

function watchForFailures(page: Page): string[] {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(`uncaught: ${error.message.split('\n')[0]}`))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console.error: ${message.text().split('\n')[0]}`)
  })
  return failures
}

/**
 * Compares every React-owned element's DOM parent with the parent React records
 * in its fiber. Imperative DOM surgery inside a React-rendered subtree — the
 * `removeChild ... not a child of this node` class — shows up here as a
 * mismatch, and the next route swap turns it into a crash.
 */
async function ownershipViolations(page: Page): Promise<{ checked: number; violations: string[] }> {
  return page.evaluate(() => {
    const roots = document.querySelectorAll<HTMLElement>('.documentation-prose[data-prose="react"]')
    const violations: string[] = []
    let checked = 0
    const fiberOf = (node: Element): { return?: unknown } | undefined => {
      const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'))
      return key ? (node as unknown as Record<string, { return?: unknown }>)[key] : undefined
    }
    const walk = (node: Element): void => {
      const fiber = fiberOf(node)
      if (fiber) {
        checked += 1
        let parent = fiber.return as { type?: unknown; stateNode?: unknown; return?: unknown } | undefined
        while (parent && typeof parent.type !== 'string') {
          parent = parent.return as typeof parent
        }
        const fiberParent = parent?.stateNode
        if (fiberParent instanceof Element && fiberParent !== node.parentElement) {
          violations.push(
            `<${node.tagName.toLowerCase()}> dom parent .${node.parentElement?.className ?? '(none)'} ` +
            `but React records .${fiberParent.className}`,
          )
        }
      }
      for (const child of Array.from(node.children)) walk(child)
    }
    for (const root of Array.from(roots)) walk(root)
    return { checked, violations }
  })
}

async function hydrate(page: Page): Promise<void> {
  await page.goto('/docs')
  await expect(page.locator('#deepspace-documentation-root')).toHaveAttribute(
    'data-documentation-hydrated',
    'true',
  )
}

function navigationLink(page: Page, name: string) {
  return page.locator('.documentation-sidebar, .documentation-frame')
    .getByRole('link', { name, exact: true }).first()
}

async function navigateTo(page: Page, name: string): Promise<void> {
  await navigationLink(page, name).click()
  await expect(page.locator('.documentation-article h1')).toHaveText(name)
}

test('the prose subtree declares exactly one writer', async ({ page }) => {
  await hydrate(page)
  const prose = page.locator('.documentation-prose').first()
  expect(
    await prose.getAttribute('data-prose'),
    'every rendered prose subtree names its owner',
  ).toMatch(/^(react|html)$/)

  // Whichever owner is in play, the code-block wrapper must exist and each `pre`
  // must sit inside it — the two runtimes reach the same structure by different
  // routes and neither may leave a `pre` unwrapped or double-wrapped.
  const blocks = await page.locator('.documentation-prose .documentation-code-block').count()
  const pres = await page.locator('.documentation-prose pre').count()
  expect(blocks).toBeGreaterThan(0)
  expect(blocks).toBe(pres)
  expect(await page.locator('.documentation-code-block > pre').count()).toBe(pres)
  expect(await page.locator('.documentation-code-actions button').count()).toBeGreaterThan(0)
})

test('tab groups stay interactive across navigation', async ({ page }) => {
  const failures = watchForFailures(page)
  await hydrate(page)
  const group = page.locator('[data-tab-group]').first()
  test.skip(await group.count() === 0, 'this fixture has no tab groups')

  const tablist = group.getByRole('tab')
  await expect(tablist.first()).toHaveAttribute('aria-selected', 'true')
  // Only the selected panel is exposed; the rest carry `hidden`.
  await expect(group.getByRole('tabpanel')).toHaveText(/First panel/)

  await tablist.nth(1).click()
  await expect(tablist.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tablist.first()).toHaveAttribute('aria-selected', 'false')
  await expect(group.getByRole('tabpanel')).toHaveText(/Second panel/)

  // Selection is shared, so the second group on the page follows the first.
  const second = page.locator('[data-tab-group]').nth(1)
  if (await second.count() > 0) {
    await expect(second.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
  }

  await navigateTo(page, 'Guide')
  await expect(page.locator('[data-tab-group]').first().getByRole('tab').first()).toBeVisible()
  expect((await ownershipViolations(page)).violations).toEqual([])
  expect(failures).toEqual([])
})

test('multi-page navigation in both directions holds ownership', async ({ page }) => {
  const failures = watchForFailures(page)
  await hydrate(page)

  for (const name of ['Guide', 'Reference', 'Guide', 'Home', 'Reference', 'Home']) {
    await navigateTo(page, name)
    expect((await ownershipViolations(page)).violations, `after navigating to ${name}`).toEqual([])
    expect(failures, `after navigating to ${name}`).toEqual([])
  }

  await page.goBack()
  await expect(page.locator('.documentation-article h1')).toHaveText('Reference')
  await page.goBack()
  await expect(page.locator('.documentation-article h1')).toHaveText('Home')
  await page.goForward()
  await expect(page.locator('.documentation-article h1')).toHaveText('Reference')

  expect(failures).toEqual([])
  expect((await ownershipViolations(page)).violations).toEqual([])
  // The article must still be intact: a torn subtree renders no prose at all.
  expect(await page.locator('.documentation-prose').count()).toBe(1)
  expect(await page.locator('.documentation-code-block').count()).toBeGreaterThan(0)
})

test('rapid navigation without settling holds ownership', async ({ page }) => {
  const failures = watchForFailures(page)
  await hydrate(page)

  for (const name of ['Guide', 'Reference', 'Home', 'Guide', 'Reference']) {
    // Deliberately no settle: overlapping route swaps must not interleave two
    // writers on the article subtree.
    await navigationLink(page, name).click()
    await page.waitForTimeout(40)
  }
  await expect(page.locator('.documentation-article h1')).toHaveText('Reference')
  await page.waitForTimeout(400)

  expect(failures).toEqual([])
  expect((await ownershipViolations(page)).violations).toEqual([])
  expect(await page.locator('.documentation-prose').count()).toBe(1)
})

test('code-block controls survive navigation and stay operable', async ({ page }) => {
  const failures = watchForFailures(page)
  await hydrate(page)
  const before = await page.locator('.documentation-code-actions button').count()
  await navigateTo(page, 'Guide')
  await navigateTo(page, 'Home')
  expect(await page.locator('.documentation-code-actions button').count()).toBe(before)
  await page.locator('.documentation-code-actions button').first().click()
  expect(failures).toEqual([])
})

test('the route swap is a cut: settled scroll observes exactly [oldY, 0] and nothing animates the article', async ({ page }) => {
  const failures = watchForFailures(page)
  await hydrate(page)

  // Settle at a deep scroll offset and let the router record it.
  await page.evaluate(() => window.scrollTo({ top: 1500, behavior: 'instant' }))
  await page.waitForTimeout(180)
  await page.evaluate(() => {
    const seen: number[] = [window.scrollY]
    ;(window as unknown as Record<string, unknown>).__scrollTrace = seen
    window.addEventListener('scroll', () => {
      if (seen[seen.length - 1] !== window.scrollY) seen.push(window.scrollY)
    })
  })

  await navigateTo(page, 'Guide')
  await page.waitForTimeout(150)

  // The scroll happens inside the same commit as the swap: no frame at the old
  // offset on the new page, no smooth glide, no post-swap snap.
  const trace = await page.evaluate(() => (window as unknown as Record<string, unknown>).__scrollTrace)
  expect(trace).toEqual([1500, 0])

  // The article never animates on navigation — a fade or view transition here
  // is the text-ghosting failure mode this gate exists to keep dead.
  const articleAnimations = await page.evaluate(() =>
    document.getAnimations().filter((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target
      return target instanceof Element && target.closest('.documentation-article') !== null
    }).length)
  expect(articleAnimations).toBe(0)
  expect(failures).toEqual([])
})
