import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import generouted from '@generouted/react-router/plugin'
import { cloudflare } from '@cloudflare/vite-plugin'
import checker from 'vite-plugin-checker'

/** Cloudflare emits preview-only secrets beside its worker bundle. DeepSpace
 * has one local runtime (`dev start`), so do not retain that second copy. */
function removeBuildPreviewSecrets(): Plugin {
  return {
    name: 'deepspace-remove-build-preview-secrets',
    enforce: 'post',
    closeBundle() {
      const outputRoot = fileURLToPath(new URL('./dist', import.meta.url))
      if (!existsSync(outputRoot)) return
      for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const secretPath = join(outputRoot, entry.name, '.dev.vars')
        if (!existsSync(secretPath)) continue
        unlinkSync(secretPath)
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    generouted(),
    cloudflare(),
    removeBuildPreviewSecrets(),
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
    dedupe: ['react', 'react-dom', 'better-auth'],
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
