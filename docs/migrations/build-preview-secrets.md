# Build-preview secret cleanup

Use this retrofit only when `deepspace app update` reports that an existing
app-owned `vite.config.*` lacks DeepSpace's build-preview cleanup. Fresh
scaffolds already contain it, and the updater deliberately does not rewrite a
configuration the app owns.

Cloudflare's Vite plugin may materialize `.dev.vars` beside the preview worker.
DeepSpace deploy deletes that generated copy before collecting artifacts, but a
direct `vite build` also needs the Vite completion hook so generic CI archives
cannot retain the plaintext file.

## Why there are two deletes (decided 2026-08-16)

Both mechanisms stay, and they now share ONE implementation —
`removeBuildDevVars` in `packages/deepspace/src/build/plugin.ts`:

| Call site                                                | Covers                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `deepspaceBuild().closeBundle` (`src/build/plugin.ts`)   | every `vite build` of an app that adopted the plugin — `npm run build`, CI archives, any non-deploy build |
| `buildDeployBundle` (`src/cli/commands/deploy/build.ts`) | **authoritative**: the exact worker dir the deploy reads, including apps that do not use the plugin       |

Neither subsumes the other: they have different lifetimes (any build vs. the
artifact that ships), so deleting the plugin sweep would leave a plain
`npm run build` emitting the plaintext file again — the case this guide exists
for. What was actually duplicated was the _code_, and only the CLI copy carried
the symlink guard; the plugin now calls the same guarded function, and the
deploy path keeps failing the deploy (`build_output_unsafe`) when the path is
unsafe. Do not add a third copy — call `removeBuildDevVars`.

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
