/**
 * CLI surface for schema lint.
 *
 * `lintSchema` findings otherwise print only from the worker console when a
 * RecordRoom DO constructs — after a client connects, interleaved with the
 * rest of the runtime log, and never at deploy time. These are exactly the
 * warnings that ship as privacy/permission bugs (e.g. a declared
 * visibilityField that no role actually enforces), so `dev` and `deploy`
 * also run them up front where the developer is already looking.
 *
 * Bundles the app's `src/schemas.ts` with esbuild and imports the resulting
 * ESM — the same approach `deploy` uses for `src/subscriptions.ts`. Lint is
 * advisory: any failure to load or parse returns null and the command
 * proceeds (the worker still warns at runtime).
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lintSchema, type CollectionSchema } from '../../server/schemas/registry'

/**
 * Lint every schema exported from `<appDir>/src/schemas.ts`.
 * Returns the warning messages (empty = clean), or null when the file is
 * absent or couldn't be loaded — callers should stay quiet on null.
 */
export async function lintProjectSchemas(appDir: string): Promise<string[] | null> {
  const schemasPath = join(appDir, 'src', 'schemas.ts')
  if (!existsSync(schemasPath)) return null

  let schemas: unknown
  try {
    const esbuild = await import('esbuild')
    const outFile = join(appDir, '.wrangler', 'deploy', 'schemas.lint.bundle.mjs')
    await esbuild.build({
      entryPoints: [schemasPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node18',
      outfile: outFile,
      logLevel: 'silent',
      write: true,
    })
    // Cache-bust the import so repeat runs in the same Node process don't
    // reuse a stale module from the loader cache.
    const mod = (await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)) as {
      schemas?: unknown
    }
    schemas = mod.schemas
  } catch {
    // Say why lint is being skipped — a schema graph esbuild can't bundle
    // (e.g. a transitive `cloudflare:workers` import) would otherwise read
    // as "schemas are clean".
    console.warn(
      'Schema lint skipped: could not bundle src/schemas.ts (the worker still lints at runtime).',
    )
    return null
  }

  if (!Array.isArray(schemas)) return null

  const findings: string[] = []
  for (const schema of schemas) {
    if (!schema || typeof schema !== 'object') continue
    try {
      findings.push(...lintSchema(schema as CollectionSchema))
    } catch {
      // A malformed schema entry fails loudly at runtime anyway — skip here.
    }
  }
  return findings
}

/** Max findings printed in full — the rest collapse to a count so a
 * pathological schema file can't flood the terminal (or an agent's context). */
const MAX_PRINTED_FINDINGS = 5

/**
 * Format findings as printable lines. Empty input → empty output (print
 * nothing when clean — lint earns attention by being rare).
 */
export function formatSchemaLintFindings(findings: string[]): string[] {
  if (findings.length === 0) return []
  const n = findings.length
  const shown = findings.slice(0, MAX_PRINTED_FINDINGS)
  const hidden = n - shown.length
  return [
    `Schema lint: ${n} warning${n === 1 ? '' : 's'} in src/schemas.ts — ${n === 1 ? 'this ships' : 'these ship'} as permission/privacy bugs:`,
    ...shown.map((f) => `  • ${f}`),
    ...(hidden > 0 ? [`  …and ${hidden} more — fix the above and re-run to see the rest.`] : []),
  ]
}
