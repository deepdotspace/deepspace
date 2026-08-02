import { defineConfig } from 'vitest/config'

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
// Unit tests live next to the source they cover (src/**/*.test.ts[x]).
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
