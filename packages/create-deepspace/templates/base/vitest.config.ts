import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { appIdDefine } from 'deepspace/build'

const appDir = fileURLToPath(new URL('.', import.meta.url))

// Dedicated Vitest config, intentionally standalone (Vitest prefers this file
// over vite.config.ts, so the app build config is never loaded for unit tests).
//
// Two reasons it exists:
//   1. vite.config.ts is built for the Cloudflare Worker / rolldown-vite
//      toolchain (@cloudflare/vite-plugin, generouted, vite-plugin-checker).
//      Vitest cannot load those plugins, and they are irrelevant to unit tests.
//   2. Vitest's default `include` would sweep up the Playwright specs in
//      tests/*.spec.ts and fail. Scoping to src keeps the runners separate:
//      unit tests here, Playwright via `npm test` / tests/playwright.config.ts.
//
// Unit tests live next to the source they cover (src/**/*.{test,spec}.ts[x]).
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
