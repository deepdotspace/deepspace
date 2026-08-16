# Build-preview secret cleanup

Use this retrofit only when `deepspace app update` reports that an existing
app-owned `vite.config.*` lacks DeepSpace's build-preview cleanup. Fresh
scaffolds already contain it, and the updater deliberately does not rewrite a
configuration the app owns.

Cloudflare's Vite plugin may materialize `.dev.vars` beside the preview worker.
DeepSpace deploy deletes that generated copy before collecting artifacts, but a
direct `vite build` also needs the Vite completion hook so generic CI archives
cannot retain the plaintext file.

Preferred (0.23.0+): adopt the `deepspaceBuild()` plugin, which owns this
cleanup along with the build-time app-id define:

```ts
import { deepspaceBuild } from 'deepspace/build'
// plugins: [..., cloudflare(), deepspaceBuild({ appDir })]
```

For an app that cannot adopt `deepspace/build` yet, add this inline plugin
immediately after `cloudflare()` in the `plugins` array (with `existsSync`,
`readdirSync`, `unlinkSync` from `node:fs` and `join` from `node:path`):

```ts
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
```

Preserve the app's other plugins and configuration.

Verify without reading secret contents:

```bash
npm run build
find dist -name '.dev.vars' -print
```

The second command must print nothing. Keep the root `.dev.vars` ignored; it is
the generated local runtime cache and is not the build artifact removed here.
