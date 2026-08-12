# Build-preview secret cleanup

Use this retrofit only when `deepspace app update` reports that an existing
app-owned `vite.config.*` lacks DeepSpace's build-preview cleanup. Fresh
scaffolds already contain it, and the updater deliberately does not rewrite a
configuration the app owns.

Cloudflare's Vite plugin may materialize `.dev.vars` beside the preview worker.
DeepSpace deploy deletes that generated copy before collecting artifacts, but a
direct `vite build` also needs the Vite completion hook so generic CI archives
cannot retain the plaintext file.

Copy `removeBuildPreviewSecrets()` and its `node:fs` / `node:path` imports from
the current
[`packages/create-deepspace/templates/base/vite.config.ts`](../../packages/create-deepspace/templates/base/vite.config.ts),
then add `removeBuildPreviewSecrets()` immediately after `cloudflare()` in the
app's `plugins` array. Preserve the app's other plugins and configuration.

Verify without reading secret contents:

```bash
npm run build
find dist -name '.dev.vars' -print
```

The second command must print nothing. Keep the root `.dev.vars` ignored; it is
the generated local runtime cache and is not the build artifact removed here.
