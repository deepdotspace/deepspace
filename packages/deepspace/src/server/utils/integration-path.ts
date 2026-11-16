/**
 * The api-worker path an app's integration call reaches. Route params arrive
 * decoded (`%2F` is `/`, `%5C` is `\`) and `fetch` collapses `..`, so a name
 * built into the path unchecked can reach any other api-worker route with the
 * app's identity and, for owner-billed calls, the owner's token.
 */

import { SAFE_PATH_SEGMENT } from '../../shared/lookup-own'

/** `/api/integrations/<name>/<endpoint>`, or null unless both are plain identifiers. */
export function integrationPath(name: string, endpoint: string): string | null {
  if (!SAFE_PATH_SEGMENT.test(name) || !SAFE_PATH_SEGMENT.test(endpoint)) return null
  return `/api/integrations/${name}/${endpoint}`
}

/**
 * Splits `'fal/run-model'` into its parts and api-worker path, or null unless
 * it is exactly two plain identifiers.
 */
export function splitIntegrationEndpoint(
  value: string,
): { name: string; endpoint: string; path: string } | null {
  const [name, endpoint, ...rest] = value.split('/')
  if (rest.length > 0 || endpoint === undefined) return null
  const path = integrationPath(name, endpoint)
  return path ? { name, endpoint, path } : null
}
