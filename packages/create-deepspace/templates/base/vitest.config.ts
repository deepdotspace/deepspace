import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { appIdDefine } from 'deepspace/build'

const appDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  // Same app id the bundle is built with, from the same wrangler config —
  // so a unit test importing src/constants.ts sees what the browser will.
  define: appIdDefine({ appDir }),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Unit tests only; tests/*.spec.ts are Playwright suites run separately.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
  },
})
