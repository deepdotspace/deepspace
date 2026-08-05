import { expect, test } from '@playwright/test'

test('navigation preserves the shell and synchronizes browser state', async ({ page }) => {
  await page.goto('/docs')
  const root = page.locator('#deepspace-documentation-root')
  await expect(root).toHaveAttribute('data-documentation-hydrated', 'true')
  await page.evaluate(() => {
    const state = window as typeof window & {
      __documentationShell?: HTMLElement | null
      __documentationPageHides?: number
    }
    state.__documentationShell = document.getElementById('deepspace-documentation-root')
    state.__documentationPageHides = 0
    window.addEventListener('pagehide', () => {
      state.__documentationPageHides = (state.__documentationPageHides ?? 0) + 1
    })
  })

  const draft = page.locator('#deepspace-documentation-assistant-launcher-input')
  await draft.fill('persistent router draft')
  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500)
  await page.evaluate(() => new Promise(requestAnimationFrame))
  const homeScroll = await page.evaluate(() => window.scrollY)
  const historyLength = await page.evaluate(() => history.length)

  await page.getByRole('link', { name: 'Guide', exact: true }).first().click()
  await expect(page).toHaveURL('/docs/guide')
  await expect(page.locator('.documentation-article h1')).toBeFocused()
  await expect(draft).toHaveValue('persistent router draft')
  await expect(page).toHaveTitle('Guide · Routing Acceptance')
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Guide metadata.',
  )
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'http://127.0.0.1:4178/docs/guide',
  )
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'Guide')
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1)
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { __documentationShell?: HTMLElement | null }
      return state.__documentationShell === document.getElementById('deepspace-documentation-root')
    }),
  ).toBe(true)
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1)
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __documentationPageHides?: number }).__documentationPageHides,
    ),
  ).toBe(0)

  await page.goBack()
  await expect(page).toHaveURL('/docs')
  await expect(page).toHaveTitle('Home · Routing Acceptance')
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Home metadata.',
  )
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(homeScroll - 100)
  await expect(draft).toHaveValue('persistent router draft')
  expect(
    await page.evaluate(() => {
      const state = window as typeof window & { __documentationShell?: HTMLElement | null }
      return state.__documentationShell === document.getElementById('deepspace-documentation-root')
    }),
  ).toBe(true)
})
