import { defineConfig } from 'tsup'
import { cpSync } from 'fs'
import { resolve } from 'path'

const alias = { '@': resolve(__dirname, 'src') }

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      'better-auth',
      'better-auth/react',
      'better-auth/client/plugins',
      'jose',
      'yjs',
      'hono',
      'lucide-react',
      'framer-motion',
      'react-router-dom',
      'clsx',
      'tailwind-merge',
    ],
    esbuildOptions(options) {
      options.jsx = 'automatic'
      options.alias = alias
    },
  },
  {
    entry: { schema: 'src/schema.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
  {
    // Public React primitives used by an app-owned documentation.tsx. These resolve
    // React from the target app and never enter the CLI bundle.
    entry: {
      'documentation-client-core': 'src/documentation/runtime/client.tsx',
      'documentation-react': 'src/documentation/runtime/public.tsx',
      'documentation-server-core': 'src/documentation/runtime/server.tsx',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react/jsx-runtime'],
    esbuildOptions(options) {
      options.jsx = 'automatic'
      options.alias = alias
    },
  },
  {
    entry: { worker: 'src/worker.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: [
      'better-auth',
      'better-auth/plugins',
      'jose',
      'yjs',
      'hono',
      'ai',
      '@ai-sdk/anthropic',
      '@ai-sdk/openai',
      '@ai-sdk/openai-compatible',
      /^cloudflare:.*/,
      /^node:.*/,
    ],
    esbuildOptions(options) {
      options.alias = alias
    },
  },
  {
    entry: { cli: 'src/cli/cli.ts' },
    format: ['esm'],
    sourcemap: true,
    external: ['citty', '@clack/prompts', /^node:.*/],
    banner: { js: '#!/usr/bin/env node' },
    esbuildOptions(options) {
      options.alias = alias
    },
  },
  {
    // `add` imports this exact entry from the target app's installed SDK so
    // feature mutations always use that app-pinned catalog and installer.
    entry: { 'feature-installer': 'src/cli/commands/feature-installer.ts' },
    format: ['esm'],
    sourcemap: true,
    external: [/^node:.*/],
  },
  {
    // `testing` carries the Playwright fixture; `testing/mcp` is the
    // dependency-free MCP wire client, a separate entry so importing it
    // never loads @playwright/test.
    entry: { testing: 'src/testing/index.ts', 'testing-mcp': 'src/testing/mcp.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: ['@playwright/test', /^node:.*/],
    esbuildOptions(options) {
      options.alias = alias
    },
  },
  {
    // Node-only documentation compiler. Its source graph contains no React
    // import; rendering and hydration are isolated artifacts below.
    entry: { documentation: 'src/documentation/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: [/^node:.*/],
    esbuildOptions(options) {
      options.alias = alias
    },
    // The compiler reads these bytes relative to its own module URL, so the
    // published layout must mirror the source tree's `fonts/` sibling.
    onSuccess: async () => {
      cpSync(resolve(__dirname, 'src/documentation/fonts'), resolve(__dirname, 'dist/fonts'), {
        recursive: true,
      })
    },
  },
  {
    // Default SSR is CommonJS because react-dom/server contains CommonJS
    // builtin loads that cannot be safely embedded in an ESM CLI artifact.
    entry: { 'documentation-default-renderer': 'src/documentation/runtime/default-renderer.tsx' },
    format: ['cjs'],
    platform: 'node',
    dts: false,
    sourcemap: false,
    splitting: false,
    minify: true,
    noExternal: ['react', 'react-dom'],
    outExtension: () => ({ js: '.cjs' }),
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuildOptions(options) {
      options.jsx = 'automatic'
      options.alias = alias
    },
  },
  {
    // Self-contained browser hydration runtime for generated documentation.
    entry: { 'documentation-runtime': 'src/documentation/runtime/auto-client.tsx' },
    format: ['iife'],
    platform: 'browser',
    dts: false,
    minify: true,
    sourcemap: false,
    splitting: false,
    outExtension: () => ({ js: '.js' }),
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuildOptions(options) {
      options.jsx = 'automatic'
      options.alias = alias
    },
  },
  // Server entry: helpers app authors import inside their own worker
  // (refundInvoice, requireSubscription, room handlers, etc.). Documentation references
  // `import { ... } from 'deepspace/server'`, so this also needs a matching
  // `exports['./server']` in package.json.
  {
    entry: { server: 'src/server/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    external: [
      'better-auth',
      'better-auth/plugins',
      'jose',
      'yjs',
      'hono',
      'ai',
      '@ai-sdk/anthropic',
      '@ai-sdk/openai',
      '@ai-sdk/openai-compatible',
      /^cloudflare:.*/,
      /^node:.*/,
    ],
    esbuildOptions(options) {
      options.alias = alias
    },
  },
])
