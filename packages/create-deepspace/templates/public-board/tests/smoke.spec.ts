import { test, expect } from '@playwright/test'
test('public board saves and survives a reload', async ({ page }) => {
  const text = `Idea ${Date.now()}`
  await page.goto('/')
  await page.getByLabel('New idea').fill(text)
  await page.getByRole('button', { name: 'Add idea' }).click()
  const item = page.getByRole('checkbox', { name: `Complete ${text}`, exact: true })
  await expect(item).toBeVisible()
  // The checkbox flips only after the server confirms, so click and wait.
  await item.click()
  await expect(item).toBeChecked()
  await page.reload()
  await expect(item).toBeChecked()
})
