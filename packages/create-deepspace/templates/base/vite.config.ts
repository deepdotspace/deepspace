import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import generouted from '@generouted/react-router/plugin'
import { cloudflare } from '@cloudflare/vite-plugin'
import checker from 'vite-plugin-checker'
import { deepspaceBuild } from 'deepspace/build'

const appDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    generouted(),
    cloudflare(),
    // The app id `define`, the preview-secret cleanup, and the client dedupe
    // hint — all shipped by the SDK so a fix to any of them arrives with a
    // version bump, not an app edit. The app id is read from the wrangler
    // config THIS build targets (wrangler.toml, or the env-flattened config
    // `deepspace deploy --env` generates); src/constants.ts is the only
    // consumer.
    deepspaceBuild({ appDir }),
    // Runs the Rules of Hooks lint (see eslint.config.js) automatically, so
    // there's no separate step to remember: a violation surfaces as an overlay
    // during `deepspace dev start` and fails the build during `deepspace deploy`.
    // That stops the cryptic "Minified React error #310 / #300" crash before
    // it can ship.
    checker({
      eslint: {
        lintCommand: 'eslint .',
        useFlatConfig: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    // generouted loads routes via `import.meta.glob`, which Vite's esbuild dep-scanner
    // does not evaluate — so every dep reachable only through the page tree (UI libs,
    // and deepspace via _app.tsx) is invisible to the cold scan, discovered late, and
    // triggers a re-optimize + full reload on first `dev` boot. That reload is where a
    // transient "Cannot read properties of null (reading 'useState')" can surface before
    // the error boundary recovers. Point the scanner at the route files (plus the html
    // entry) so the first optimize pass is complete and no late re-optimize fires.
    // Scoped to src/pages (NOT all of src) so worker-only modules — actions, cron, jobs,
    // ai, which import deepspace/worker — are not dragged into the client optimizer.
    // Dev-only; `vite build` ignores optimizeDeps.
    entries: ['./index.html', './src/pages/**/*.tsx'],
  },
})
