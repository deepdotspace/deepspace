/**
 * Routing decisions the deploy worker, the CLI, and the scaffold all depend
 * on. One home so they cannot drift — see docs/platform/app-platform-contract.md
 * for why this boundary needs one.
 */

/** Where every release serves its own identity. The deploy worker injects this
 *  asset; the CLI polls it to learn which release an edge is serving. */
export const RELEASE_STAMP_PATH = '/.well-known/deepspace/release.json'

/**
 * What the asset layer does with a path it has no file for — Cloudflare's own
 * `not_found_handling`, restated here because both ends of a deploy have to
 * agree on the legal values.
 *
 * The app declares this and the platform honors it. It is the app's to declare
 * because it is half of a decision whose other half lives in the app's worker:
 * `none` sends misses to the worker, which is the only place that can tell a
 * client route from a missing file, and a worker written for one setting
 * misbehaves under the other. Overriding it from here would silently rewrite
 * the behavior of code the platform did not write — see
 * docs/platform/app-platform-contract.md.
 */
export const ASSET_NOT_FOUND_HANDLING_VALUES = [
  'none',
  'single-page-application',
  '404-page',
] as const

export type AssetNotFoundHandling = (typeof ASSET_NOT_FOUND_HANDLING_VALUES)[number]

/**
 * Applied when a deploy declares nothing.
 *
 * This is NOT Cloudflare's default (`none`) and not the value new apps ship.
 * It is what the platform hardcoded for every app before it started honoring
 * the declaration, and a deploy carrying no declaration is a CLI too old to
 * send one — necessarily paired with an app written for the old behavior.
 * Anything else here breaks every app whose CLI has not been upgraded, which
 * is the failure Rule 1 exists to prevent.
 */
export const UNDECLARED_ASSET_NOT_FOUND_HANDLING: AssetNotFoundHandling =
  'single-page-application'

export function isAssetNotFoundHandling(value: unknown): value is AssetNotFoundHandling {
  return (ASSET_NOT_FOUND_HANDLING_VALUES as readonly unknown[]).includes(value)
}

/** Stated, not inherited from the compatibility date: from 2025-04-01 the
 *  default sends navigations to the asset layer, which under
 *  `not_found_handling: "none"` would 404 every client route before the
 *  worker sees it. Required for every app, whatever it declares above. */
export const REQUIRED_COMPATIBILITY_FLAGS = [
  'nodejs_compat',
  'assets_navigation_has_no_effect',
] as const

/** Each reverses something above, so an app may not set it. */
const CONTRADICTORY_COMPATIBILITY_FLAGS = new Set([
  'no_nodejs_compat',
  'assets_navigation_prefers_asset_serving',
])

/** Required flags plus whatever the app added that does not contradict them. */
export function resolveCompatibilityFlags(declared: readonly string[] | undefined): string[] {
  const flags = new Set<string>(REQUIRED_COMPATIBILITY_FLAGS)
  for (const flag of declared ?? []) {
    if (typeof flag !== 'string') continue
    const trimmed = flag.trim()
    if (!trimmed || CONTRADICTORY_COMPATIBILITY_FLAGS.has(trimmed)) continue
    flags.add(trimmed)
  }
  return [...flags]
}

/** Routes Cloudflare hands to the worker before the asset layer answers. The
 *  agent paths are here so an app publishing nothing there 404s instead of
 *  returning its homepage. */
export const SDK_RUN_WORKER_FIRST = [
  '/api/*',
  '/ws/*',
  '/internal/*',
  '/v1/*',
  '/_deepspace/*',
  '/llms.txt',
  '/llms-full.txt',
  '/.well-known/mcp',
  '/.well-known/mcp.json',
  '/.well-known/mcp/*',
] as const

/** Published documentation: reserved from an app's config, but NOT worker-first
 *  — it is static files, and an invocation to hand back an asset is waste. */
const DOCUMENTATION_PATHS = [
  '/_documentation',
  '/_documentation/*',
  '/_documentation-root',
  '/_documentation-root/*',
] as const

/** Deny-list for an app's own `run_worker_first`. Strictly wider than what the
 *  platform routes worker-first; expressing it as a superset keeps the
 *  difference deliberate. */
export const RESERVED_RUN_WORKER_FIRST: readonly string[] = [
  ...SDK_RUN_WORKER_FIRST,
  ...DOCUMENTATION_PATHS,
]

/**
 * Whether the platform owns this path — so an app's worker must answer 404
 * rather than its shell when nothing is published there. Exported as a
 * predicate, not a list, because the patterns carry globs and every caller
 * matching them by hand is another copy that can drift.
 */
export function isPlatformReservedPath(pathname: string): boolean {
  return RESERVED_RUN_WORKER_FIRST.some((pattern) => {
    if (!pattern.endsWith('/*')) return pathname === pattern
    const base = pattern.slice(0, -2)
    return pathname === base || pathname.startsWith(`${base}/`)
  })
}
