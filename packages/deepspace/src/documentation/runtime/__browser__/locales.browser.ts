import { expect, test, type Page } from '@playwright/test'

const origin = 'http://127.0.0.1:4178'

function languageAlternates(page: Page): Promise<string[]> {
  return page.locator('link[rel="alternate"][hreflang]').evaluateAll((links) =>
    links.map((link) => `${(link as HTMLLinkElement).hreflang} ${(link as HTMLLinkElement).href}`))
}

test('language links load the other locale as a document; in-locale links stay client-side', async ({ page }) => {
  await page.goto('/docs/guide')
  const root = page.locator('#deepspace-documentation-root')
  await expect(root).toHaveAttribute('data-documentation-hydrated', 'true')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  const guideCluster = [
    `en ${origin}/docs/guide`,
    `es ${origin}/docs/es/guide`,
    `x-default ${origin}/docs/guide`,
  ]
  expect(await languageAlternates(page)).toEqual(guideCluster)

  // Each locale has its own navigation and search index: switching is a document load.
  await page.locator('.documentation-sidebar .documentation-language-links').getByRole('link', { name: 'Español' }).click()
  await expect(page).toHaveURL('/docs/es/guide')
  await expect(root).toHaveAttribute('data-documentation-hydrated', 'true')
  await expect(page.locator('html')).toHaveAttribute('lang', 'es')
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${origin}/docs/es/guide`)
  expect(await languageAlternates(page)).toEqual(guideCluster)
  await expect(page.locator('.documentation-sidebar .documentation-nav-section h2')).toHaveText('Inicio')

  await page.evaluate(() => { (window as typeof window & { __sameDocument?: boolean }).__sameDocument = true })
  await page.locator('.documentation-prose').getByRole('link', { name: 'Portada' }).click()
  await expect(page).toHaveURL('/docs/es')
  await expect(page).toHaveTitle('Portada · Routing Acceptance')
  expect(await page.evaluate(() => (window as typeof window & { __sameDocument?: boolean }).__sameDocument)).toBe(true)
  // The home URL keeps the canonical's trailing slash.
  expect(await languageAlternates(page)).toEqual([
    `en ${origin}/docs/`,
    `es ${origin}/docs/es`,
    `x-default ${origin}/docs/`,
  ])

  // Each locale searches its own index; sites with locales search every script.
  await page.keyboard.press('Control+k')
  await page.locator('.documentation-search-input input').fill('Guía')
  await expect(page.locator('.documentation-search-result').first()).toHaveAttribute('href', '/docs/es/guide')
  await page.keyboard.press('Escape')

  // The untranslated reference is English: following it leaves the Spanish document.
  await page.locator('.documentation-prose').getByRole('link', { name: 'Referencia' }).click()
  await expect(page).toHaveURL('/docs/reference')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  expect(await page.evaluate(() => (window as typeof window & { __sameDocument?: boolean }).__sameDocument)).toBeUndefined()
  expect(await languageAlternates(page)).toEqual([])
  await page.keyboard.press('Control+k')
  await page.locator('.documentation-search-input input').fill('Reference')
  await expect(page.locator('.documentation-search-result').first()).toHaveAttribute('href', '/docs/reference')
})
