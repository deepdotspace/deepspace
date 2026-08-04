import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
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
