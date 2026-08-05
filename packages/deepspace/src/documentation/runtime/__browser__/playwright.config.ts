import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'routing.browser.ts',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'pnpm exec tsx src/documentation/runtime/__browser__/server.ts',
    cwd: new URL('../../../..', import.meta.url).pathname,
    url: 'http://127.0.0.1:4178/docs',
    reuseExistingServer: false,
  },
})
