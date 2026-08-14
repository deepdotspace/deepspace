import { defineConfig } from '@playwright/test'

const cwd = new URL('../../../..', import.meta.url).pathname
const defaultRuntime = 'http://127.0.0.1:4178'
const customRuntime = 'http://127.0.0.1:4179'

/**
 * Two fixtures, because the two runtimes own the article subtree differently:
 * 4178 serves Markdown pages through the default runtime (the compiler's HTML is
 * injected), 4179 serves MDX pages with an app-owned `documentation.tsx` through
 * the executable runtime (React renders the prose). Runtime-agnostic specs run
 * against both.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.browser.ts',
  timeout: 60_000,
  use: { browserName: 'chromium', headless: true },
  projects: [
    // `routing.browser.ts` asserts the default fixture's own titles and canonical
    // URLs, so it stays on the default runtime; everything else is
    // runtime-agnostic and runs against both.
    { name: 'default-runtime', use: { baseURL: defaultRuntime } },
    {
      name: 'custom-runtime',
      testIgnore: 'routing.browser.ts',
      use: { baseURL: customRuntime },
    },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx src/documentation/runtime/__browser__/server.ts',
      cwd,
      url: `${defaultRuntime}/docs`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'pnpm exec tsx src/documentation/runtime/__browser__/custom-server.ts',
      cwd,
      url: `${customRuntime}/docs`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
})
