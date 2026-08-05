import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DocumentationBuildManifest } from './types'

/**
 * The app's own Vite build is the one documentation compile owner: its
 * `deepSpaceDocumentation()` plugin writes the release artifacts (stamped
 * with `DEEPSPACE_DOCUMENTATION_BASE_URL` when deploy sets it) into the
 * asset output. Deploy only reads the manifest it produced.
 */
export function readDocumentationDeployManifest(
  appDir: string,
  clientDir: string,
): DocumentationBuildManifest | undefined {
  if (!existsSync(join(appDir, 'documentation.json'))) return undefined
  const manifestPath = join(clientDir, '_documentation', 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      'documentation.json exists but the build produced no documentation manifest. ' +
        'Ensure vite.config.ts includes deepSpaceDocumentation() from deepspace/documentation.',
    )
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as DocumentationBuildManifest
}
